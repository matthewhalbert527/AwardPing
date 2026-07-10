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
import { loadAiReviewCoverageSummary } from "@/lib/admin-ai-review-coverage";
import {
  adminCommandPanelCommands,
  loadSourceQualityAdminSummary,
  loadSuppressionSummary,
  loadVisualReviewBatchSummary,
  parseLatestWorkerReportMetadata,
  summarizeBackfillCompletion,
  summarizeAiMode,
  summarizeCaptureProfile,
  summarizeDailyWorkerHealth,
  summarizeDiscovery,
  summarizeExpandableSections,
  summarizeGeminiBatchStatus,
  summarizePreAiGate,
  summarizeSuppressionAndLastKnownGood,
  summarizeTextOnlyChanges,
  type ReasonCount,
} from "@/lib/admin-maintenance";
import { loadPageAuditSummary } from "@/lib/admin-page-audits";
import { loadAwardReconciliationSummary } from "@/lib/admin-reconciliation";
import { loadSourceIntakeSummary } from "@/lib/admin-source-intake";
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
  const showLegacyAdmin = process.env.NEXT_PUBLIC_SHOW_ADMIN_LEGACY === "true";
  const counts = await loadAdminSourceCounts(admin, { includeCycleCoverage: showLegacyAdmin });
  const [
    sourceQualityResult,
    visualReviewBatchResult,
    suppressionResult,
    aiCoverageResult,
    reconciliationResult,
    pageAuditResult,
    sourceIntakeResult,
  ] = await Promise.all([
    loadSourceQualityAdminSummary(admin, counts.recentRuns, {
      openSources: counts.openSources,
      reviewLaterSources: counts.reviewLaterSources,
    }),
    loadVisualReviewBatchSummary(admin),
    loadSuppressionSummary(admin),
    loadAiReviewCoverageSummary(admin, counts.recentRuns),
    loadAwardReconciliationSummary(admin, counts.recentRuns),
    loadPageAuditSummary(admin),
    loadSourceIntakeSummary(admin, counts.recentRuns),
  ]);
  const workerMetadata = parseLatestWorkerReportMetadata(counts.recentRuns);
  const sourceQuality = sourceQualityResult.summary;
  const aiCoverage = aiCoverageResult.summary;
  const reconciliation = reconciliationResult.summary;
  const pageAudit = pageAuditResult.summary;
  const sourceIntake = sourceIntakeResult.summary;
  const discovery = summarizeDiscovery(workerMetadata.latestVisualMetadata);
  const visualReviewBatch = visualReviewBatchResult.summary;
  const preAiGate = summarizePreAiGate(workerMetadata.latestVisualMetadata);
  const textOnlyChanges = summarizeTextOnlyChanges(workerMetadata.latestVisualMetadata);
  const suppression = suppressionResult.summary;
  const captureProfile = summarizeCaptureProfile(workerMetadata.latestVisualMetadata);
  const sectionSummary = summarizeExpandableSections(workerMetadata.latestVisualMetadata);
  const aiMode = summarizeAiMode(workerMetadata.latestVisualMetadata);
  const backfillCompletion = summarizeBackfillCompletion(workerMetadata.latestBackfillMetadata);
  const dailyHealth = summarizeDailyWorkerHealth(
    Object.keys(workerMetadata.latestDailyMetadata).length
      ? workerMetadata.latestDailyMetadata
      : workerMetadata.latestMaintenanceMetadata,
  );
  const geminiBatchHealth = summarizeGeminiBatchStatus(workerMetadata, visualReviewBatch);
  const suppressionAndLastKnownGood = summarizeSuppressionAndLastKnownGood(
    suppression,
    workerMetadata.latestReconciliationMetadata,
  );
  const commandPanelCommands = adminCommandPanelCommands();
  const latestMaintenance = latestMaintenanceRun(counts.recentRuns);
  const renderedAt = new Date().toISOString();
  const metadataPercent = percent(counts.openWithMetadata, counts.openSources);
  const cyclePercent = percent(
    counts.cycleCoverage.sourcesWithCycleRelevance,
    Math.max(1, counts.cycleCoverage.sourcesWithFacts),
  );
  const visualPercent = percent(counts.openWithVisualSnapshots, counts.openSources);
  const sourceQualityMeasured = sourceQuality.metricMode !== "fast_counts";
  const sourceGateAttention = sourceQualityMeasured && sourceQuality.openRejectedSources > 0;
  const sourceGateValue = sourceQualityMeasured
    ? `${formatNumber(sourceQuality.monitorEligibleSources)} / ${formatNumber(sourceQuality.openSources)}`
    : formatNumber(sourceQuality.openSources);
  const sourceGateDetail = sourceQualityMeasured
    ? `${formatNumber(sourceQuality.openRejectedSources)} open sources are blocked before monitoring.`
    : "Open sources counted quickly; gate eligibility will appear after the next source-quality worker report.";
  const monitorEligibleDisplay = sourceQualityMeasured
    ? formatNumber(sourceQuality.monitorEligibleSources)
    : "Not reported";
  const publicEligibleDisplay = sourceQualityMeasured
    ? formatNumber(sourceQuality.publicEligibleSources)
    : "Not reported";
  const factEligibleDisplay = sourceQualityMeasured
    ? formatNumber(sourceQuality.factEligibleSources)
    : "Not reported";
  const openRejectedDisplay = sourceQualityMeasured
    ? formatNumber(sourceQuality.openRejectedSources)
    : "Not reported";
  const catchupSourceEstimate = sourceQualityMeasured ? sourceQuality.monitorEligibleSources : counts.openSources;
  const estimatedCatchupCost = catchupSourceEstimate * GEMINI_BATCH_COST_PER_SOURCE_USD;
  const geminiBlocked = recentRunsIncludeGeminiCreditBlock(counts.recentRuns);
  const allLoadErrors = [
    ...counts.loadErrors,
    ...sourceQualityResult.loadErrors,
    ...visualReviewBatchResult.loadErrors,
    ...suppressionResult.loadErrors,
    ...aiCoverageResult.loadErrors,
    ...reconciliationResult.loadErrors,
    ...pageAuditResult.loadErrors,
    ...sourceIntakeResult.loadErrors,
  ];
  const adminWarnings = [
    ...aiCoverageResult.warnings,
    ...reconciliationResult.warnings,
    ...pageAuditResult.warnings,
    ...sourceIntakeResult.warnings,
  ];
  const visualQueueCount = visualReviewBatch.statusCounts.pending +
    visualReviewBatch.statusCounts.submitted +
    visualReviewBatch.statusCounts.processing;
  const reconciliationQueueCount = reconciliation.queueCounts.pending + reconciliation.queueCounts.processing;
  const intakeQueueCount = sourceIntake.pending + sourceIntake.inProgress + sourceIntake.needsManualReview;
  const pageBlockerCount = pageAudit.critical +
    reconciliation.queueCounts.failed +
    (reconciliation.latestRun?.awardsPublicationBlocked || 0) +
    (dailyHealth.awardsPublicationBlocked || 0);
  const dataQualityAttentionCount = (sourceQualityMeasured ? sourceQuality.openRejectedSources : 0) +
    aiCoverage.unreviewed_open_sources +
    aiCoverage.open_sources_with_award_relevance_unclear +
    aiCoverage.open_sources_with_award_relevance_unrelated +
    (aiCoverage.open_category_counts.sibling_but_open || 0) +
    aiCoverage.open_sources_missing_cycle_relevance;
  const attentionItems = [
    {
      show: geminiBlocked,
      title: "Gemini credits are blocking AI catch-up",
      detail: aiCoverage.latest_gemini_billing_quota_blocker?.blocking_reason ||
        "Recent workers reported Gemini billing, quota, or depleted-credit errors.",
      status: "blocked",
      href: null,
      icon: AlertTriangle,
    },
    {
      show: allLoadErrors.length > 0,
      title: "Some admin data failed to load",
      detail: allLoadErrors.slice(0, 2).join(" "),
      status: "load error",
      href: null,
      icon: AlertTriangle,
    },
    {
      show: adminWarnings.length > 0,
      title: "Optional workflow tables are not fully migrated",
      detail: adminWarnings.slice(0, 2).join(" "),
      status: "optional",
      href: null,
      icon: AlertTriangle,
    },
    {
      show: pageBlockerCount > 0,
      title: "Public page publication has blockers",
      detail: `${formatNumber(pageBlockerCount)} reconciliation or audit blockers need review.`,
      status: "page audit",
      href: "/dashboard/admin/issues?category=page_audit_critical",
      icon: AlertTriangle,
    },
    {
      show: dataQualityAttentionCount > 0,
      title: "Source quality still needs cleanup",
      detail: `${formatNumber(dataQualityAttentionCount)} open-source review or relevance issues are still visible to the gate.`,
      status: "source gate",
      href: "/dashboard/admin/issues?category=source_quality_rejected_but_monitoring_enabled",
      icon: Database,
    },
    {
      show: textOnlyChanges.textOnlyIgnored > 0,
      title: "Text-only changes were ignored",
      detail: `${formatNumber(textOnlyChanges.textOnlyIgnored)} text-only changes should be classified or explicitly accepted as noise.`,
      status: "text-only",
      href: null,
      icon: AlertTriangle,
    },
    {
      show: dailyHealth.standardCaptureCreatedSources,
      title: "A capture run created sources",
      detail: "Discovery should stay separate from standard visual capture runs.",
      status: "discovery",
      href: null,
      icon: AlertTriangle,
    },
    {
      show: intakeQueueCount > 0,
      title: "Source intake has pending work",
      detail: `${formatNumber(intakeQueueCount)} intake requests are pending, running, or waiting for manual review.`,
      status: "intake",
      href: "/dashboard/admin/source-intake",
      icon: Database,
    },
  ].filter((item) => item.show);

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
        <div className="flex flex-wrap gap-3">
          <Link className="button-secondary" href="/dashboard/admin/source-intake">
            <Database size={16} aria-hidden="true" />
            Source Intake
          </Link>
          <Link className="button-secondary" href="/dashboard/admin/issues">
            <AlertTriangle size={16} aria-hidden="true" />
            Page Issues
          </Link>
        </div>
      </div>

      {showLegacyAdmin && (
        <>
          {allLoadErrors.length > 0 && (
            <section className="card border-[var(--brand-pink)] p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle size={18} aria-hidden="true" />
                <div>
                  <h2 className="font-black">Some admin data could not be loaded</h2>
                  <p className="mt-1 text-sm text-[var(--muted)]">{allLoadErrors.join(" ")}</p>
                </div>
              </div>
            </section>
          )}

          {adminWarnings.length > 0 && (
            <section className="card p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle size={18} aria-hidden="true" />
                <div>
                  <h2 className="font-black">Some workflow tables are optional or not migrated yet</h2>
                  <p className="mt-1 text-sm text-[var(--muted)]">{adminWarnings.join(" ")}</p>
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
        </>
      )}

      <section className="admin-metric-grid admin-metric-grid-primary">
        <MetricCard
          icon={Clock3}
          label="Runner"
          value={latestMaintenance ? statusLabel(latestMaintenance.run.status) : "None"}
          detail={latestMaintenance ? latestMaintenanceDetail(latestMaintenance) : "No command-center run has reported yet."}
          attention={latestMaintenance?.run.status === "failed"}
        />
        <MetricCard
          icon={Database}
          label="Source Gate"
          value={sourceGateValue}
          detail={sourceGateDetail}
          attention={sourceGateAttention}
        />
        <MetricCard
          icon={Sparkles}
          label="Public Pages"
          value={`${aiCoverage.percent_complete_public_award_pages}%`}
          detail={`${formatNumber(aiCoverage.awards_with_no_public_facts)} active awards still need reconciled public facts.`}
          attention={aiCoverage.awards_with_no_public_facts > 0 || pageBlockerCount > 0}
        />
        <MetricCard
          icon={Gauge}
          label="Active Queue"
          value={formatNumber(visualQueueCount + reconciliationQueueCount + intakeQueueCount)}
          detail="Visual reviews, reconciliation, and source-intake work waiting or processing."
          attention={visualQueueCount + reconciliationQueueCount + intakeQueueCount > 0}
        />
      </section>

      <section className="admin-dashboard-grid">
        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} aria-hidden="true" />
              <h2>Needs Attention</h2>
            </div>
            <span className={attentionItems.length > 0 ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {attentionItems.length > 0 ? `${attentionItems.length} items` : "Clear"}
            </span>
          </div>
          {attentionItems.length > 0 ? (
            <div className="admin-flow-list admin-flow-list-compact">
              {attentionItems.map((item) => {
                const row = (
                  <PipelineRow
                    attention
                    detail={item.detail}
                    icon={item.icon}
                    key={item.title}
                    status={item.status}
                    title={item.title}
                  />
                );
                return item.href ? (
                  <Link className="admin-clean-link" href={item.href} key={item.title}>
                    {row}
                  </Link>
                ) : row;
              })}
            </div>
          ) : (
            <p className="text-sm font-semibold leading-6 text-[var(--muted)]">
              No blocking conditions are visible in the latest worker reports.
            </p>
          )}
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Activity size={18} aria-hidden="true" />
              <h2>Daily Flow</h2>
            </div>
            <span className={latestMaintenance?.run.status === "failed" ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {latestMaintenance ? statusLabel(latestMaintenance.run.status) : "No report"}
            </span>
          </div>
          <div className="admin-flow-list admin-flow-list-compact">
            <PipelineRow
              detail={sourceQualityMeasured
                ? `${formatNumber(sourceQuality.monitorEligibleSources)} monitorable sources; ${formatNumber(sourceQuality.openRejectedSources)} blocked by quality gate.`
                : "Source-quality eligibility is waiting on the latest worker report; live scan skipped for page speed."}
              icon={Database}
              status="source gate"
              title="1. Clean source set"
              attention={sourceGateAttention}
            />
            <PipelineRow
              detail={`${captureProfile.captureProfile || "Unknown"} profile; ${formatDurationMs(captureProfile.scrollActivationWaitMs)} scroll wait in latest visual report.`}
              icon={Activity}
              status={discovery.discoveryMode ? "discovery mode" : "capture mode"}
              title="2. Stable capture"
              attention={dailyHealth.standardCaptureCreatedSources}
            />
            <PipelineRow
              detail={`${formatNumber(preAiGate.candidateChanges)} candidates, ${formatNumber(preAiGate.aiReviewed)} AI-reviewed, ${formatNumber(preAiGate.trueChangesPublished)} published.`}
              icon={Gauge}
              status={`${preAiGate.trueChangeRate}% true`}
              title="3. Pre-AI gate"
              attention={textOnlyChanges.textOnlyIgnored > 0}
            />
            <PipelineRow
              detail={`${formatNumber(visualQueueCount)} visual reviews and ${formatNumber(reconciliationQueueCount)} award reconciliations are pending or processing.`}
              icon={Sparkles}
              status="batch + reconcile"
              title="4. Review and reconcile"
              attention={visualQueueCount + reconciliationQueueCount > 0 || reconciliation.queueCounts.failed > 0}
            />
            <PipelineRow
              detail={`${formatNumber(pageAudit.critical)} critical audits; ${formatNumber(suppression.suppressedChangeEvents)} suppressed noisy change events.`}
              icon={CheckCircle2}
              status="publish guard"
              title="5. Audit public pages"
              attention={pageAudit.critical > 0 || suppressionAndLastKnownGood.publicationBlocked > 0}
            />
          </div>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Sparkles size={18} aria-hidden="true" />
              <h2>Data Quality</h2>
            </div>
            <span className={dataQualityAttentionCount > 0 ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {dataQualityAttentionCount > 0 ? `${formatNumber(dataQualityAttentionCount)} issues` : "Clean"}
            </span>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Open sources" value={sourceQuality.openSources} />
            <MiniStat label="Monitor eligible" value={monitorEligibleDisplay} />
            <MiniStat label="Gate rejected" value={openRejectedDisplay} attention={sourceGateAttention} />
            <MiniStat label="Review later" value={sourceQuality.reviewLaterSources} attention={sourceQuality.reviewLaterSources > 0} />
            <MiniStat label="Metadata" value={`${formatNumber(counts.openWithMetadata)} / ${formatNumber(counts.openSources)}`} />
            <MiniStat label="Visuals" value={`${visualPercent}%`} attention={counts.openMissingVisualSnapshots > 0} />
            <MiniStat label="Unreviewed open" value={aiCoverage.unreviewed_open_sources} attention={aiCoverage.unreviewed_open_sources > 0} />
            <MiniStat label="Unclear/unrelated" value={aiCoverage.open_sources_with_award_relevance_unclear + aiCoverage.open_sources_with_award_relevance_unrelated} attention={aiCoverage.open_sources_with_award_relevance_unclear + aiCoverage.open_sources_with_award_relevance_unrelated > 0} />
            <MiniStat label="Missing cycle" value={aiCoverage.open_sources_missing_cycle_relevance} attention={aiCoverage.open_sources_missing_cycle_relevance > 0} />
            <MiniStat label="Audit critical" value={pageAudit.critical} attention={pageAudit.critical > 0} />
          </div>
          <DetailDisclosure label="What is being rejected">
            <ReasonCountList counts={sourceQuality.rejectedByReason} empty="No open sources are currently rejected by the source-quality gate." />
            {!sourceQualityMeasured && sourceQuality.metricsWarning ? (
              <p className="mt-3 text-sm font-semibold leading-6 text-[var(--muted)]">
                {sourceQuality.metricsWarning}
              </p>
            ) : null}
            <div className="admin-issue-actions mt-3">
              <Link className="admin-issue-link" href="/dashboard/admin/issues?tab=source-quality">
                Review source-quality rejects
              </Link>
              <Link className="admin-issue-link" href="/dashboard/admin/issues?category=page_audit_critical">
                Review page blockers
              </Link>
            </div>
          </DetailDisclosure>
        </div>

        <div className="card admin-section-card admin-dashboard-card admin-maintenance-control-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <PlayCircle size={18} aria-hidden="true" />
              <h2>Run Workers</h2>
            </div>
            <StatusPill status="ready" />
          </div>
          <p className="text-sm font-semibold leading-6 text-[var(--muted)]">
            Worker control stays on the Windows PC. Run commands from
            <span className="font-mono"> C:\Users\matth\Documents\AwardPing Project</span>.
          </p>
          <div className="grid gap-3">
            <CommandLine command="npm run command:center -- status" />
            <CommandLine command="npm run command:center -- start --profile=catchup --apply=true --baseline-cost-cap-usd=10" />
            <CommandLine command="npm run command:center -- profiles" />
          </div>
          <DetailDisclosure label="Latest report">
            {latestMaintenance ? (
              <>
                <dl className="admin-detail-grid admin-detail-grid-tight">
                  <Detail label="Profile" value={latestMaintenance.profile || "Unknown"} />
                  <Detail label="Started" value={formatDate(latestMaintenance.run.started_at)} />
                  <Detail label="Finished" value={latestMaintenance.run.finished_at ? formatDate(latestMaintenance.run.finished_at) : "Still running"} />
                  <Detail label="Report" value={latestMaintenance.reportPath || "Supabase status only"} />
                </dl>
                <div className="admin-flow-list admin-flow-list-compact">
                  {latestMaintenance.phases.slice(0, 5).map((phase) => (
                    <PipelineRow
                      attention={phase.status === "failed"}
                      detail={phase.finished_at ? `Finished ${formatDate(phase.finished_at)}` : "Still running"}
                      icon={phase.status === "failed" ? AlertTriangle : CheckCircle2}
                      key={`${phase.name}-${phase.started_at}`}
                      status={statusLabel(phase.status || "running")}
                      title={phase.name || "phase"}
                    />
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm font-semibold leading-6 text-[var(--muted)]">
                No local command-center maintenance run has been written to Supabase yet.
              </p>
            )}
          </DetailDisclosure>
        </div>
      </section>

      <section className="card admin-section-card admin-dashboard-card">
        <div className="admin-panel-heading">
          <div className="flex items-center gap-2">
            <ServerCog size={18} aria-hidden="true" />
            <h2>Advanced Diagnostics</h2>
          </div>
          <span className="badge">Collapsed</span>
        </div>
        <DetailDisclosure label="Queues and batch workers">
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Visual pending" value={visualReviewBatch.statusCounts.pending} attention={visualReviewBatch.statusCounts.pending > 0} />
            <MiniStat label="Visual processing" value={visualReviewBatch.statusCounts.processing} attention={visualReviewBatch.statusCounts.processing > 0} />
            <MiniStat label="Visual failed" value={visualReviewBatch.statusCounts.failed} attention={visualReviewBatch.statusCounts.failed > 0} />
            <MiniStat label="Reconcile pending" value={reconciliation.queueCounts.pending} attention={reconciliation.queueCounts.pending > 0} />
            <MiniStat label="Reconcile failed" value={reconciliation.queueCounts.failed} attention={reconciliation.queueCounts.failed > 0} />
            <MiniStat label="Intake pending" value={sourceIntake.pending} attention={sourceIntake.pending > 0} />
            <MiniStat label="Manual intake" value={sourceIntake.needsManualReview} attention={sourceIntake.needsManualReview > 0} />
            <MiniStat label="Page unresolved" value={pageAudit.unresolved} attention={pageAudit.unresolved > 0} />
          </div>
          <dl className="admin-detail-grid admin-detail-grid-tight">
            <Detail label="Latest visual batch" value={visualReviewBatch.latestBatchName || "None"} />
            <Detail label="Visual model" value={visualReviewBatch.model || "Unknown"} />
            <Detail label="Baseline batch" value={geminiBatchHealth.latestBaselineBatchJob || "None"} />
            <Detail label="Page audit batch" value={geminiBatchHealth.latestPageAuditBatchJob || pageAudit.latestBatch.name || "None"} />
            <Detail label="Blocking reason" value={geminiBatchHealth.blockingReason || "None"} />
            <Detail label="Estimated visual cost" value={`$${formatUsd(visualReviewBatch.estimatedCostUsd)}`} />
          </dl>
        </DetailDisclosure>
        <DetailDisclosure label="Capture and change detection">
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Discovery candidates" value={discovery.discoveryCandidates} />
            <MiniStat label="Inserted open" value={discovery.discoveryInsertedOpen} attention={discovery.discoveryInsertedOpen > 0} />
            <MiniStat label="Pre-AI candidates" value={preAiGate.candidateChanges} />
            <MiniStat label="Noise rejected" value={preAiGate.deterministicNoiseRejected} />
            <MiniStat label="Text ignored" value={textOnlyChanges.textOnlyIgnored} attention={textOnlyChanges.textOnlyIgnored > 0} />
            <MiniStat label="Expansion shots" value={captureProfile.expansionScreenshotsTaken} attention={captureProfile.expansionScreenshotsTaken > 0} />
            <MiniStat label="R2 unchanged skip" value={captureProfile.r2UploadsSkippedUnchanged} />
            <MiniStat label="Chrome-only changed" value={captureProfile.chromeOnlyHashChanged} attention={captureProfile.chromeOnlyHashChanged > 0} />
          </div>
          <dl className="admin-detail-grid admin-detail-grid-tight">
            <Detail label="Capture profile" value={captureProfile.captureProfile || "Unknown"} />
            <Detail label="Page-ready wait" value={formatDurationMs(captureProfile.pageReadyWaitMs)} />
            <Detail label="Settle wait" value={formatDurationMs(captureProfile.captureSettleWaitMs)} />
            <Detail label="Scroll wait" value={formatDurationMs(captureProfile.scrollActivationWaitMs)} />
          </dl>
        </DetailDisclosure>
        <DetailDisclosure label="Expandable sections">
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Detected" value={sectionSummary.detected} />
            <MiniStat label="Extracted" value={sectionSummary.extracted} attention={sectionSummary.detected > sectionSummary.extracted} />
            <MiniStat label="Changed" value={sectionSummary.changed} />
            <MiniStat label="Candidates" value={sectionSummary.candidatesEnqueued} />
            <MiniStat label="Evidence shots" value={sectionSummary.evidenceScreenshotsTaken} attention={sectionSummary.evidenceScreenshotsTaken > 0 && sectionSummary.profile === "stable-daily"} />
            <MiniStat label="Main hash includes sections" value={sectionSummary.textIncludedInMainHash === null ? "Unknown" : sectionSummary.textIncludedInMainHash ? "Yes" : "No"} attention={sectionSummary.profile === "stable-daily" && sectionSummary.textIncludedInMainHash === true} />
          </div>
        </DetailDisclosure>
        <DetailDisclosure label="AI mode, suppression, and budget">
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="AI required" value={aiMode.aiRequired === null ? "Unknown" : aiMode.aiRequired ? "Yes" : "No"} />
            <MiniStat label="Suppressed events" value={suppression.suppressedChangeEvents} attention={suppression.suppressedChangeEvents > 0} />
            <MiniStat label="Last-known-good" value={suppressionAndLastKnownGood.awardsUsingLastKnownGood} attention={suppressionAndLastKnownGood.awardsUsingLastKnownGood > 0} />
            <MiniStat label="Catch-up estimate" value={`$${formatUsd(estimatedCatchupCost)}`} attention={geminiBlocked} />
            <MiniStat label="Default cap" value={`$${formatUsd(DEFAULT_BASELINE_COST_CAP_USD)}`} />
            <MiniStat label="Avg/page" value={`$${formatUsd(GEMINI_BATCH_COST_PER_SOURCE_USD)}`} />
          </div>
          <dl className="admin-detail-grid admin-detail-grid-tight">
            <Detail label="AI provider" value={aiMode.aiProvider || "None"} />
            <Detail label="Disabled reason" value={aiMode.aiDisabledReason || "None"} />
            <Detail label="Visual review mode" value={aiMode.visualReviewMode || "Unknown"} />
            <Detail label="Gemini pricing mode" value={aiMode.geminiApiPricingMode || "Unknown"} />
            <Detail label="Backfill status" value={backfillCompletion.status === "unknown" ? "No report" : statusLabel(backfillCompletion.status)} />
            <Detail label="Backfill blocker" value={backfillCompletion.blockingReason || "None"} />
          </dl>
          <ReasonCountList counts={suppression.suppressionReasons} empty="No suppressed event reasons recorded." title="Suppression reasons" />
        </DetailDisclosure>
        <DetailDisclosure label="Profiles and recent workers">
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
          <div className="admin-flow-list admin-flow-list-compact">
            {counts.recentRuns.slice(0, 5).map((run) => (
              <PipelineRow
                attention={run.status === "failed"}
                detail={`${formatDate(run.started_at)}; checked ${formatNumber(run.checked_count)}, changed ${formatNumber(run.changed_count)}, failed ${formatNumber(run.failed_count)}`}
                icon={run.status === "failed" ? AlertTriangle : Activity}
                key={run.id}
                status={statusLabel(run.status)}
                title={run.worker_name}
              />
            ))}
          </div>
          <div className="mt-3 grid gap-3">
            {commandPanelCommands.map((item) => (
              <div className="grid gap-1" key={item.command}>
                <p className="text-xs font-black uppercase text-[var(--muted)]">{item.label}</p>
                <CommandLine command={item.command} />
              </div>
            ))}
          </div>
        </DetailDisclosure>
      </section>

      {showLegacyAdmin && (
        <>
      <section className="admin-metric-grid admin-metric-grid-primary">
        <MetricCard
          icon={ServerCog}
          label="Worker Control"
          value="Local Only"
          detail="Start and stop workers from the local command center; this page reflects the latest reported status."
        />
        <MetricCard
          icon={Database}
          label="Open / Eligible"
          value={`${formatNumber(sourceQuality.openSources)} / ${formatNumber(sourceQuality.monitorEligibleSources)}`}
          detail={`${formatNumber(counts.activeAwards)} active awards; open is not the same as safe`}
        />
        <MetricCard
          icon={CheckCircle2}
          label="Monitor Eligible"
          value={formatNumber(sourceQuality.monitorEligibleSources)}
          detail={`${formatNumber(sourceQuality.openRejectedSources)} open sources are rejected before capture/update monitoring`}
          attention={sourceQuality.openRejectedSources > 0}
        />
        <MetricCard
          icon={Sparkles}
          label="Public / Facts"
          value={`${formatNumber(sourceQuality.publicEligibleSources)} / ${formatNumber(sourceQuality.factEligibleSources)}`}
          detail="Sources eligible for public display and award-fact aggregation"
          attention={sourceQuality.factEligibleSources < sourceQuality.publicEligibleSources}
        />
        <MetricCard
          icon={AlertTriangle}
          label="Gate Rejected"
          value={formatNumber(sourceQuality.openRejectedSources)}
          detail={`${formatNumber(sourceQuality.reviewLaterSources)} sources are already in review_later`}
          attention={sourceQuality.openRejectedSources > 0}
        />
        <MetricCard
          icon={Database}
          label="Review Later"
          value={formatNumber(sourceQuality.reviewLaterSources)}
          detail="Sources held out of the public/monitoring path for review"
          attention={sourceQuality.reviewLaterSources > 0}
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
            <span className="badge">{metadataPercent}% facts / {cyclePercent}% cycle</span>
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
              <CheckCircle2 size={18} aria-hidden="true" />
              <h2>Award Page Reconciliation</h2>
            </div>
            <span className={reconciliation.configured ? "badge" : "badge bg-[var(--brand-pink-soft)]"}>
              {reconciliation.configured ? "Queued" : "Not configured"}
            </span>
          </div>
          {reconciliation.warning && (
            <p className="text-sm font-semibold leading-6 text-[var(--muted)]">{reconciliation.warning}</p>
          )}
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Pending" value={reconciliation.queueCounts.pending} attention={reconciliation.queueCounts.pending > 0} />
            <MiniStat label="Processing" value={reconciliation.queueCounts.processing} attention={reconciliation.queueCounts.processing > 0} />
            <MiniStat label="Succeeded" value={reconciliation.queueCounts.succeeded} />
            <MiniStat label="Failed" value={reconciliation.queueCounts.failed} attention={reconciliation.queueCounts.failed > 0} />
            <MiniStat label="Skipped" value={reconciliation.queueCounts.skipped} />
            <MiniStat label="Reconciled" value={reconciliation.latestRun?.awardsReconciled || 0} />
            <MiniStat label="Blocked" value={reconciliation.latestRun?.awardsPublicationBlocked || 0} attention={(reconciliation.latestRun?.awardsPublicationBlocked || 0) > 0} />
            <MiniStat label="Last-known-good" value={reconciliation.latestRun?.awardsUsedLastKnownGood || 0} attention={(reconciliation.latestRun?.awardsUsedLastKnownGood || 0) > 0} />
            <MiniStat label="Sibling rejected" value={reconciliation.latestRun?.siblingSourcesRejected || 0} attention={(reconciliation.latestRun?.siblingSourcesRejected || 0) > 0} />
            <MiniStat label="Deadline conflicts" value={reconciliation.latestRun?.deadlineConflictsDetected || 0} attention={(reconciliation.latestRun?.deadlineConflictsDetected || 0) > 0} />
            <MiniStat label="Stale cycles fixed" value={reconciliation.latestRun?.staleCycleStatesCorrected || 0} />
            <MiniStat label="Facts published" value={reconciliation.latestRun?.factsPublished || 0} />
          </div>
          <div className="admin-issue-actions">
            <Link className="admin-issue-link" href="/dashboard/admin/issues?category=award_reconciliation_failed">
              Failed reconciliation
            </Link>
            <Link className="admin-issue-link" href="/dashboard/admin/issues?category=deadline_conflict">
              Deadline conflicts
            </Link>
          </div>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} aria-hidden="true" />
              <h2>Page Audit</h2>
            </div>
            <span className={pageAudit.critical > 0 ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {pageAudit.critical > 0 ? `${formatNumber(pageAudit.critical)} critical` : "Audited"}
            </span>
          </div>
          {pageAudit.warning && (
            <p className="text-sm font-semibold leading-6 text-[var(--muted)]">{pageAudit.warning}</p>
          )}
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Passed" value={pageAudit.statusCounts.passed} />
            <MiniStat label="Warnings" value={pageAudit.statusCounts.warnings} attention={pageAudit.statusCounts.warnings > 0} />
            <MiniStat label="Failed" value={pageAudit.statusCounts.failed} attention={pageAudit.statusCounts.failed > 0} />
            <MiniStat label="Needs review" value={pageAudit.statusCounts.needs_review} attention={pageAudit.statusCounts.needs_review > 0} />
            <MiniStat label="Critical" value={pageAudit.severityCounts.critical} attention={pageAudit.severityCounts.critical > 0} />
            <MiniStat label="Unresolved" value={pageAudit.unresolved} attention={pageAudit.unresolved > 0} />
          </div>
          <DetailDisclosure label="Common findings">
            <ReasonCountList counts={pageAudit.commonFindings} empty="No audit findings recorded." />
          </DetailDisclosure>
          <div className="admin-flow-list admin-flow-list-compact">
            {pageAudit.latestExamples.slice(0, 3).map((audit) => (
              <PipelineRow
                attention={audit.severity === "critical" || audit.severity === "error"}
                detail={audit.finding}
                icon={audit.severity === "critical" ? AlertTriangle : Activity}
                key={audit.id}
                status={audit.severity}
                title={audit.awardName}
              />
            ))}
          </div>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Database size={18} aria-hidden="true" />
              <h2>Source Intake</h2>
            </div>
            <span className={sourceIntake.configured ? "badge" : "badge bg-[var(--brand-pink-soft)]"}>
              {sourceIntake.configured ? "Configured" : "Not configured"}
            </span>
          </div>
          {sourceIntake.warning && (
            <p className="text-sm font-semibold leading-6 text-[var(--muted)]">{sourceIntake.warning}</p>
          )}
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Pending" value={sourceIntake.pending} attention={sourceIntake.pending > 0} />
            <MiniStat label="In progress" value={sourceIntake.inProgress} attention={sourceIntake.inProgress > 0} />
            <MiniStat label="Added" value={sourceIntake.added} />
            <MiniStat label="Rejected" value={sourceIntake.rejected} />
            <MiniStat label="Manual review" value={sourceIntake.needsManualReview} attention={sourceIntake.needsManualReview > 0} />
            <MiniStat label="Failed" value={sourceIntake.failed} attention={sourceIntake.failed > 0} />
          </div>
          <dl className="admin-detail-grid admin-detail-grid-tight">
            <Detail label="Latest worker" value={sourceIntake.latestWorker?.status || "Not reported"} />
            <Detail label="Created sources" value={formatNumber(sourceIntake.latestWorker?.createdOrUpdatedSources || 0)} />
            <Detail label="Gemini blocker" value={sourceIntake.latestWorker?.blockingReason || "None"} />
          </dl>
          <div className="admin-issue-actions">
            <Link className="admin-issue-link" href="/dashboard/admin/source-intake">
              Manage source intake
            </Link>
            <Link className="admin-issue-link" href="/dashboard/admin/issues?category=source_intake_needs_manual_review">
              Intake issues
            </Link>
          </div>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Sparkles size={18} aria-hidden="true" />
              <h2>AI Review Coverage</h2>
            </div>
            <span className={aiCoverage.completion_passed ? "badge" : "badge bg-[var(--brand-pink-soft)]"}>
              {aiCoverage.completion_passed ? "Complete" : "Blocked"}
            </span>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat
              label="Open reviewed"
              value={`${formatNumber(aiCoverage.open_sources - aiCoverage.unreviewed_open_sources)} / ${formatNumber(aiCoverage.open_sources)}`}
              attention={aiCoverage.unreviewed_open_sources > 0}
            />
            <MiniStat
              label="All reviewed"
              value={`${aiCoverage.percent_complete_all_sources}%`}
              attention={aiCoverage.percent_complete_all_sources < 100}
            />
            <MiniStat
              label="Public pages"
              value={`${aiCoverage.percent_complete_public_award_pages}%`}
              attention={aiCoverage.awards_with_no_public_facts > 0}
            />
            <MiniStat label="Unreviewed open" value={aiCoverage.unreviewed_open_sources} attention={aiCoverage.unreviewed_open_sources > 0} />
            <MiniStat label="Unrelated open" value={aiCoverage.open_sources_with_award_relevance_unrelated} attention={aiCoverage.open_sources_with_award_relevance_unrelated > 0} />
            <MiniStat label="Unclear open" value={aiCoverage.open_sources_with_award_relevance_unclear} attention={aiCoverage.open_sources_with_award_relevance_unclear > 0} />
            <MiniStat label="Sibling open" value={aiCoverage.open_category_counts.sibling_but_open || 0} attention={(aiCoverage.open_category_counts.sibling_but_open || 0) > 0} />
            <MiniStat label="Missing cycle" value={aiCoverage.open_sources_missing_cycle_relevance} attention={aiCoverage.open_sources_missing_cycle_relevance > 0} />
            <MiniStat label="Missing evidence" value={aiCoverage.open_category_counts.missing_evidence || 0} attention={(aiCoverage.open_category_counts.missing_evidence || 0) > 0} />
            <MiniStat label="Review failed" value={aiCoverage.open_sources_with_review_failed_status} attention={aiCoverage.open_sources_with_review_failed_status > 0} />
            <MiniStat label="Manual review" value={aiCoverage.open_category_counts.needs_manual_review || 0} attention={(aiCoverage.open_category_counts.needs_manual_review || 0) > 0} />
            <MiniStat label="Audit critical" value={aiCoverage.critical_page_audit_failures} attention={aiCoverage.critical_page_audit_failures > 0} />
          </div>
          <dl className="admin-detail-grid admin-detail-grid-tight">
            <Detail label="Latest coverage pass" value={aiCoverage.latest_backfill_run_status?.status || "Not reported"} />
            <Detail
              label="Gemini blocker"
              value={aiCoverage.latest_gemini_billing_quota_blocker?.blocking_reason || (geminiBlocked ? "Billing or quota blocker detected" : "None")}
            />
          </dl>
          <DetailDisclosure label="Completion blockers">
            <ReasonCountList counts={objectCounts(aiCoverage.completion_blockers)} empty="No hard completion blockers reported." />
            <div className="mt-3 grid gap-2">
              <CommandLine command="node scripts/read-ai-review-coverage.mjs --json" />
              <CommandLine command="node scripts/backfill-open-source-ai-determinations.mjs --dry-run=true" />
              <CommandLine command="node scripts/backfill-open-source-ai-determinations.mjs --apply=true --gemini-api-mode=batch --resume" />
            </div>
          </DetailDisclosure>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={18} aria-hidden="true" />
              <h2>Source Quality</h2>
            </div>
            <span className="badge">
              {!sourceQualityMeasured
                ? "Fast counts"
                : sourceQuality.latestCleanupRun?.apply === false
                ? "Dry run"
                : sourceQuality.latestCleanupRun?.apply
                  ? "Applied"
                  : "Current gate"}
            </span>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Open" value={sourceQuality.openSources} />
            <MiniStat label="Monitor eligible" value={monitorEligibleDisplay} />
            <MiniStat label="Public eligible" value={publicEligibleDisplay} />
            <MiniStat label="Fact eligible" value={factEligibleDisplay} />
            <MiniStat label="Open rejected" value={openRejectedDisplay} attention={sourceGateAttention} />
            <MiniStat label="Review later" value={sourceQuality.reviewLaterSources} attention={sourceQuality.reviewLaterSources > 0} />
          </div>
          {sourceQuality.latestCleanupRun ? (
            <dl className="admin-detail-grid admin-detail-grid-tight">
              <Detail label="Latest run" value={sourceQuality.latestCleanupRun.label} />
              <Detail label="Status" value={statusLabel(sourceQuality.latestCleanupRun.status)} />
              <Detail label="Candidates" value={formatNullableNumber(sourceQuality.latestCleanupRun.candidatesFound)} />
              <Detail label="Moved later" value={formatNullableNumber(sourceQuality.latestCleanupRun.movedToReviewLater)} />
              <Detail label="Skipped/manual" value={formatNullableNumber(sourceQuality.latestCleanupRun.skippedManualProtected)} />
            </dl>
          ) : (
            <p className="text-sm font-semibold leading-6 text-[var(--muted)]">
              {sourceQuality.metricsWarning ||
                "No structured source-quality cleanup report has been recorded yet."}
            </p>
          )}
          <DetailDisclosure label="Rejected by reason">
            <ReasonCountList counts={sourceQuality.rejectedByReason} empty="No open sources are currently rejected by the gate." title="Current open rejects" />
            {!sourceQualityMeasured && sourceQuality.metricsWarning ? (
              <p className="mt-3 text-sm font-semibold leading-6 text-[var(--muted)]">
                {sourceQuality.metricsWarning}
              </p>
            ) : null}
            {sourceQuality.latestCleanupRun && (
              <ReasonCountList
                counts={sourceQuality.latestCleanupRun.rejectedByReason}
                empty="No latest cleanup rejection reason counts were reported."
                title="Latest cleanup run"
              />
            )}
            <Link className="admin-issue-link mt-3 inline-flex" href="/dashboard/admin/issues?tab=source-quality">
              Review source-quality rejects
            </Link>
          </DetailDisclosure>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Database size={18} aria-hidden="true" />
              <h2>Discovery vs Capture</h2>
            </div>
            <span className={discovery.standardCaptureCreatedSources ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {discovery.discoveryMode ? "Discovery mode" : "Capture mode"}
            </span>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Candidates" value={discovery.discoveryCandidates} />
            <MiniStat label="Rejected quality" value={discovery.discoveryRejectedByQuality} />
            <MiniStat label="Inserted pending" value={discovery.discoveryInsertedPending} />
            <MiniStat label="Inserted open" value={discovery.discoveryInsertedOpen} attention={discovery.discoveryInsertedOpen > 0} />
            <MiniStat label="Rejected identity" value={discovery.discoveryRejectedByIdentity} />
            <MiniStat label="Existing skipped" value={discovery.discoverySkippedExisting} />
          </div>
          {discovery.standardCaptureCreatedSources && (
            <p className="text-sm font-black text-[var(--brand-burgundy)]">
              Warning: the latest standard capture report says it created source rows. Capture runs should not discover sources.
            </p>
          )}
          <DetailDisclosure label="Cap hits">
            <ReasonCountList counts={discovery.capHitsByAward} empty="No per-award cap hits." title="Awards" />
            <ReasonCountList counts={discovery.capHitsByDomain} empty="No per-domain cap hits." title="Domains" />
            <ReasonCountList counts={discovery.capHitsBySource} empty="No per-source cap hits." title="Sources" />
          </DetailDisclosure>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Sparkles size={18} aria-hidden="true" />
              <h2>Gemini Visual Review Batch</h2>
            </div>
            <span className={visualReviewBatch.configured ? "badge" : "badge bg-[var(--brand-pink-soft)]"}>
              {visualReviewBatch.configured ? "Configured" : "Not configured"}
            </span>
          </div>
          {visualReviewBatch.warning && (
            <p className="text-sm font-semibold leading-6 text-[var(--muted)]">{visualReviewBatch.warning}</p>
          )}
          <div className="admin-stat-grid admin-stat-grid-compact">
            {Object.entries(visualReviewBatch.statusCounts).map(([status, count]) => (
              <MiniStat key={status} label={labelize(status)} value={count} attention={status === "failed" && count > 0} />
            ))}
          </div>
          <dl className="admin-detail-grid admin-detail-grid-tight">
            <Detail label="Latest batch" value={visualReviewBatch.latestBatchName || "None"} />
            <Detail label="Model" value={visualReviewBatch.model || "Unknown"} />
            <Detail label="Requests" value={formatNumber(visualReviewBatch.requestCount)} />
            <Detail label="Submitted" value={formatOptionalDate(visualReviewBatch.submittedAt)} />
            <Detail label="Completed" value={formatOptionalDate(visualReviewBatch.completedAt)} />
            <Detail label="Estimated cost" value={`$${formatUsd(visualReviewBatch.estimatedCostUsd)}`} />
            <Detail label="Actual cost" value={visualReviewBatch.actualCostUsd === null ? "Not reported" : `$${formatUsd(visualReviewBatch.actualCostUsd)}`} />
          </dl>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Sparkles size={18} aria-hidden="true" />
              <h2>Gemini Batch / AI Worker Health</h2>
            </div>
            <span className={geminiBatchHealth.billingBlocked || geminiBatchHealth.quotaBlocked ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {geminiBatchHealth.billingBlocked ? "Billing blocked" : geminiBatchHealth.quotaBlocked ? "Quota blocked" : "Ready"}
            </span>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Billing blocked" value={geminiBatchHealth.billingBlocked ? "Yes" : "No"} attention={geminiBatchHealth.billingBlocked} />
            <MiniStat label="Quota blocked" value={geminiBatchHealth.quotaBlocked ? "Yes" : "No"} attention={geminiBatchHealth.quotaBlocked} />
            <MiniStat label="Visual queued" value={visualReviewBatch.statusCounts.pending + visualReviewBatch.statusCounts.submitted + visualReviewBatch.statusCounts.processing} />
            <MiniStat label="Visual failed" value={visualReviewBatch.statusCounts.failed} attention={visualReviewBatch.statusCounts.failed > 0} />
          </div>
          <dl className="admin-detail-grid admin-detail-grid-tight">
            <Detail label="Baseline batch" value={geminiBatchHealth.latestBaselineBatchJob || "None"} />
            <Detail label="Visual batch" value={geminiBatchHealth.latestVisualReviewBatchJob || "None"} />
            <Detail label="Page audit batch" value={geminiBatchHealth.latestPageAuditBatchJob || pageAudit.latestBatch.name || "None"} />
            <Detail label="Source intake batch" value={geminiBatchHealth.latestSourceIntakeBatchJob || "None"} />
            <Detail label="Blocking reason" value={geminiBatchHealth.blockingReason || "None"} />
          </dl>
          {geminiBatchHealth.synchronousBatchPricingWarning && (
            <p className="text-sm font-black text-[var(--brand-burgundy)]">
              Warning: a run used synchronous Gemini review while reporting batch pricing.
            </p>
          )}
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Gauge size={18} aria-hidden="true" />
              <h2>Pre-AI Gate Efficiency</h2>
            </div>
            <span className="badge">{preAiGate.trueChangeRate}% true</span>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Candidates" value={preAiGate.candidateChanges} />
            <MiniStat label="Source rejected" value={preAiGate.deterministicSourceRejected} />
            <MiniStat label="Noise rejected" value={preAiGate.deterministicNoiseRejected} />
            <MiniStat label="Text queued" value={preAiGate.textOnlyPublishedOrQueued} />
            <MiniStat label="Visual queued" value={preAiGate.visualOnlyCandidateEnqueued} />
            <MiniStat label="AI reviewed" value={preAiGate.aiReviewed} />
            <MiniStat label="AI rejected" value={preAiGate.aiRejected} />
            <MiniStat label="Published" value={preAiGate.trueChangesPublished} />
          </div>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} aria-hidden="true" />
              <h2>Text-only Changes</h2>
            </div>
            <span className={textOnlyChanges.needsAttention ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {textOnlyChanges.needsAttention ? "Needs attention" : "Handled"}
            </span>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Candidates" value={textOnlyChanges.textOnlyCandidates} />
            <MiniStat label="Noise rejected" value={textOnlyChanges.textOnlyNoiseRejected} />
            <MiniStat label="Queued/published" value={textOnlyChanges.textOnlyPublishedOrQueued} />
            <MiniStat label="Ignored" value={textOnlyChanges.textOnlyIgnored} attention={textOnlyChanges.textOnlyIgnored > 0} />
          </div>
          {textOnlyChanges.textOnlyIgnored > 0 && (
            <p className="text-sm font-black text-[var(--brand-burgundy)]">
              Text-only ignored should be zero outside explicit debug mode.
            </p>
          )}
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} aria-hidden="true" />
              <h2>Suppression</h2>
            </div>
            <span className={suppression.configured ? "badge" : "badge bg-[var(--brand-pink-soft)]"}>
              {suppression.configured ? "Configured" : "Unavailable"}
            </span>
          </div>
          {suppression.warning && (
            <p className="text-sm font-semibold leading-6 text-[var(--muted)]">{suppression.warning}</p>
          )}
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Suppressed events" value={suppression.suppressedChangeEvents} attention={suppression.suppressedChangeEvents > 0} />
            <MiniStat label="Reason types" value={suppression.suppressionReasons.length} />
            <MiniStat label="Last-known-good" value={suppressionAndLastKnownGood.awardsUsingLastKnownGood} attention={suppressionAndLastKnownGood.awardsUsingLastKnownGood > 0} />
            <MiniStat label="Publication blocked" value={suppressionAndLastKnownGood.publicationBlocked} attention={suppressionAndLastKnownGood.publicationBlocked > 0} />
          </div>
          <DetailDisclosure label="Suppression reasons">
            <ReasonCountList counts={suppression.suppressionReasons} empty="No suppressed event reasons recorded." />
            <Link className="admin-issue-link mt-3 inline-flex" href="/dashboard/admin/issues?tab=suppressed">
              Review suppressed events
            </Link>
          </DetailDisclosure>
          <div className="admin-flow-list admin-flow-list-compact">
            {suppression.latestSuppressedEvents.slice(0, 3).map((event) => (
              <PipelineRow
                attention
                detail={event.summary || event.sourceUrl || "Suppressed change event"}
                icon={AlertTriangle}
                key={event.id}
                status={event.reason || "suppressed"}
                title={event.sourceTitle || "Suppressed event"}
              />
            ))}
          </div>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Activity size={18} aria-hidden="true" />
              <h2>Capture / R2 Churn</h2>
            </div>
            <span className="badge">{captureProfile.captureProfile || "Unknown profile"}</span>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Expansion shots" value={captureProfile.expansionScreenshotsTaken} attention={captureProfile.expansionScreenshotsTaken > 0} />
            <MiniStat label="R2 unchanged skip" value={captureProfile.r2UploadsSkippedUnchanged} />
            <MiniStat label="R2 noise skip" value={captureProfile.r2UploadsSkippedNoise} />
            <MiniStat label="Main hash changed" value={captureProfile.mainContentHashChanged} />
            <MiniStat label="Chrome-only changed" value={captureProfile.chromeOnlyHashChanged} attention={captureProfile.chromeOnlyHashChanged > 0} />
            <MiniStat label="Scroll wait" value={formatDurationMs(captureProfile.scrollActivationWaitMs)} />
          </div>
          <dl className="admin-detail-grid admin-detail-grid-tight">
            <Detail label="Page-ready wait" value={formatDurationMs(captureProfile.pageReadyWaitMs)} />
            <Detail label="Settle wait" value={formatDurationMs(captureProfile.captureSettleWaitMs)} />
          </dl>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Activity size={18} aria-hidden="true" />
              <h2>Daily Worker Health</h2>
            </div>
            <span className={dailyHealth.aiReviewCoverageComplete === false || dailyHealth.textOnlyIgnored > 0 ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {dailyHealth.status === "unknown" ? "No report" : statusLabel(dailyHealth.status)}
            </span>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="AI coverage" value={dailyHealth.aiReviewCoverageComplete === null ? "Unknown" : dailyHealth.aiReviewCoverageComplete ? "Complete" : "Incomplete"} attention={dailyHealth.aiReviewCoverageComplete === false} />
            <MiniStat label="Unreviewed open" value={dailyHealth.unreviewedOpenSources} attention={dailyHealth.unreviewedOpenSources > 0} />
            <MiniStat label="Unclear open" value={dailyHealth.unclearOpenSources} attention={dailyHealth.unclearOpenSources > 0} />
            <MiniStat label="Unrelated open" value={dailyHealth.unrelatedOpenSources} attention={dailyHealth.unrelatedOpenSources > 0} />
            <MiniStat label="Missing cycle" value={dailyHealth.missingCycleRelevanceSources} attention={dailyHealth.missingCycleRelevanceSources > 0} />
            <MiniStat label="Queued awards" value={dailyHealth.awardsQueuedForReconciliation} />
            <MiniStat label="Reconciled" value={dailyHealth.awardsReconciled} attention={dailyHealth.skippedReconciliationAfterImpact} />
            <MiniStat label="Audit failed" value={dailyHealth.awardsAuditFailed} attention={dailyHealth.awardsAuditFailed > 0} />
            <MiniStat label="Blocked" value={dailyHealth.awardsPublicationBlocked} attention={dailyHealth.awardsPublicationBlocked > 0} />
            <MiniStat label="Last-known-good" value={dailyHealth.awardsUsedLastKnownGood} attention={dailyHealth.awardsUsedLastKnownGood > 0} />
            <MiniStat label="Page audit batch" value={dailyHealth.pageAuditBatchCandidates} />
            <MiniStat label="Text ignored" value={dailyHealth.textOnlyIgnored} attention={dailyHealth.textOnlyIgnored > 0} />
          </div>
          <dl className="admin-detail-grid admin-detail-grid-tight">
            <Detail label="Discovery mode" value={dailyHealth.discoveryMode === null ? "Unknown" : dailyHealth.discoveryMode ? "On" : "Off"} />
            <Detail label="Capture profile" value={dailyHealth.captureProfile || "Unknown"} />
            <Detail label="Section profile" value={dailyHealth.sectionExtractionProfile || "Unknown"} />
          </dl>
          {dailyHealth.standardCaptureCreatedSources && (
            <p className="text-sm font-black text-[var(--brand-burgundy)]">
              Warning: this daily/capture report says sources were created while discovery was off.
            </p>
          )}
          {dailyHealth.skippedReconciliationAfterImpact && (
            <p className="text-sm font-black text-[var(--brand-burgundy)]">
              Warning: awards were queued for reconciliation but no reconciliation completed in this report.
            </p>
          )}
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Database size={18} aria-hidden="true" />
              <h2>Expandable Sections</h2>
            </div>
            <span className={sectionSummary.needsAttention ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {sectionSummary.enabled === false ? "Disabled" : sectionSummary.profile || "Unknown"}
            </span>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Detected" value={sectionSummary.detected} />
            <MiniStat label="Extracted" value={sectionSummary.extracted} attention={sectionSummary.detected > sectionSummary.extracted} />
            <MiniStat label="Changed" value={sectionSummary.changed} />
            <MiniStat label="Added" value={sectionSummary.added} />
            <MiniStat label="Removed" value={sectionSummary.removed} />
            <MiniStat label="Candidates" value={sectionSummary.candidatesEnqueued} />
            <MiniStat label="Evidence shots" value={sectionSummary.evidenceScreenshotsTaken} attention={sectionSummary.evidenceScreenshotsTaken > 0 && sectionSummary.profile === "stable-daily"} />
            <MiniStat label="Main hash includes sections" value={sectionSummary.textIncludedInMainHash === null ? "Unknown" : sectionSummary.textIncludedInMainHash ? "Yes" : "No"} attention={sectionSummary.profile === "stable-daily" && sectionSummary.textIncludedInMainHash === true} />
          </div>
          {sectionSummary.profile === "stable-daily" && sectionSummary.textIncludedInMainHash === true && (
            <p className="text-sm font-black text-[var(--brand-burgundy)]">
              Stable daily runs should keep section text out of the main page hash.
            </p>
          )}
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <ServerCog size={18} aria-hidden="true" />
              <h2>AI Mode</h2>
            </div>
            <span className={aiMode.synchronousBatchPricingWarning ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {aiMode.aiRequired === false ? "AI disabled" : aiMode.aiRequired ? "AI required" : "Unknown"}
            </span>
          </div>
          <dl className="admin-detail-grid admin-detail-grid-tight">
            <Detail label="Provider" value={aiMode.aiProvider || "None"} />
            <Detail label="Disabled reason" value={aiMode.aiDisabledReason || "None"} />
            <Detail label="Visual review mode" value={aiMode.visualReviewMode || "Unknown"} />
            <Detail label="Gemini pricing mode" value={aiMode.geminiApiPricingMode || "Unknown"} />
          </dl>
          {aiMode.synchronousBatchPricingWarning && (
            <p className="text-sm font-black text-[var(--brand-burgundy)]">
              Warning: this run reported batch pricing while using immediate visual review.
            </p>
          )}
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
              <Sparkles size={18} aria-hidden="true" />
              <h2>Backfill Completion</h2>
            </div>
            <span className={backfillCompletion.completionPassed ? "badge" : "badge bg-[var(--brand-pink-soft)]"}>
              {backfillCompletion.status === "unknown" ? "No report" : statusLabel(backfillCompletion.status)}
            </span>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Open scanned" value={backfillCompletion.totalOpenSourcesScanned} />
            <MiniStat label="Queued AI" value={backfillCompletion.queuedForAiReview} />
            <MiniStat label="Batch submitted" value={backfillCompletion.submittedToGeminiBatch} />
            <MiniStat label="Moved later" value={backfillCompletion.movedToReviewLater} />
            <MiniStat label="Awards queued" value={backfillCompletion.awardsQueuedForReconciliation} />
            <MiniStat label="Reconciled" value={backfillCompletion.awardsReconciled} />
            <MiniStat label="Blocked pages" value={backfillCompletion.publicPagesBlocked} attention={backfillCompletion.publicPagesBlocked > 0} />
            <MiniStat label="Last-known-good" value={backfillCompletion.lastKnownGoodPreserved} attention={backfillCompletion.lastKnownGoodPreserved > 0} />
          </div>
          {backfillCompletion.blockingReason && (
            <p className="text-sm font-black text-[var(--brand-burgundy)]">
              {backfillCompletion.blockingReason}
            </p>
          )}
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <PlayCircle size={18} aria-hidden="true" />
              <h2>Commands</h2>
            </div>
          </div>
          <div className="grid gap-3">
            {commandPanelCommands.map((item) => (
              <div className="grid gap-1" key={item.command}>
                <p className="text-xs font-black uppercase text-[var(--muted)]">{item.label}</p>
                <CommandLine command={item.command} />
              </div>
            ))}
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
            <MiniStat label="Monitor pages" value={sourceQualityMeasured ? monitorEligibleDisplay : `${formatNumber(catchupSourceEstimate)} max`} />
            <MiniStat label="Avg/page" value={`$${formatUsd(GEMINI_BATCH_COST_PER_SOURCE_USD)}`} />
            <MiniStat label="Estimate" value={`$${formatUsd(estimatedCatchupCost)}`} attention={geminiBlocked} />
            <MiniStat label="Default cap" value={`$${formatUsd(DEFAULT_BASELINE_COST_CAP_USD)}`} />
          </div>
          <p className="text-sm font-semibold leading-6 text-[var(--muted)]">
            The estimate uses the observed Gemini Batch average from previous AwardPing runs
            {sourceQualityMeasured ? "." : " and open-source count as a fast upper bound."}
          </p>
        </div>
      </section>
        </>
      )}
    </AdminShell>
  );
}

async function loadAdminSourceCounts(
  admin: AdminClient,
  options: { includeCycleCoverage?: boolean } = {},
): Promise<AdminSourceCounts> {
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
    options.includeCycleCoverage
      ? loadCycleCoverageResult(admin)
      : Promise.resolve({ coverage: emptyCycleCoverage(), error: "" }),
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
  const openWithVisualSnapshots = Math.min(openSourceCount, visualSnapshotCount.count || 0);
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

function ReasonCountList({
  counts,
  empty,
  title,
}: {
  counts: ReasonCount[];
  empty: string;
  title?: string;
}) {
  if (counts.length === 0) {
    return (
      <p className="text-sm font-semibold leading-6 text-[var(--muted)]">
        {title ? `${title}: ` : ""}
        {empty}
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {title && <p className="text-xs font-black uppercase text-[var(--muted)]">{title}</p>}
      <div className="admin-stat-grid admin-stat-grid-compact">
        {counts.slice(0, 8).map((item) => (
          <MiniStat key={item.reason} label={labelize(item.reason)} value={item.count} attention={item.count > 0} />
        ))}
      </div>
    </div>
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

function formatOptionalDate(value: string | null) {
  return value ? formatDate(value) : "Not reported";
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatNullableNumber(value: number | null) {
  return value === null ? "Not reported" : formatNumber(value);
}

function formatDurationMs(value: number) {
  if (value <= 0) return "0s";
  if (value < 1000) return `${formatNumber(Math.round(value))}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

function formatUsd(value: number) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: value >= 1 ? 2 : 4,
  });
}

function labelize(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function objectCounts(value: Record<string, number>): ReasonCount[] {
  return Object.entries(value)
    .map(([reason, count]) => ({ reason, count }))
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function percent(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}
