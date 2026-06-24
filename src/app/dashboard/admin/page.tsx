import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Clock3,
  Database,
  Eye,
  Sparkles,
} from "lucide-react";
import { AdminAutoRefresh } from "@/components/admin-auto-refresh";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser, isSiteAdminEmail } from "@/lib/auth";
import { loadAdminPageIssues, type AdminPageIssue } from "@/lib/admin-page-issues";
import { appConfig, hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database as AwardPingDatabase, Json } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type LocalWorkerRun = AwardPingDatabase["public"]["Tables"]["local_worker_runs"]["Row"];

type BaselineCoverage = {
  loadedSources: number;
  existingBaselines: number;
  missingBaselines: number;
  actionableMissingBaselines: number;
  knownBrokenMissingBaselines: number;
};

type BaselinePace = {
  completedThisRun: number;
  pagesPerHour: number;
  etaLabel: string;
  elapsedLabel: string;
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
          <h1 className="mt-4 text-3xl font-black">Screenshot scans</h1>
          <p className="mt-2 text-[var(--muted)]">
            Supabase service-role access is not configured for this deployment, so scan details
            cannot be loaded.
          </p>
        </div>
      </AdminShell>
    );
  }

  const admin = createSupabaseAdminClient();
  const now = new Date();
  const renderedAt = now.toISOString();
  const checked24hCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const checked48hCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const checked7dCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [
    { data: workerRunRows, error: workerRunError },
    { count: sharedSourceCount, error: sharedSourceError },
    { count: activeSharedSourceCount, error: activeSharedSourceError },
    { count: sourceMetadataCount, error: sourceMetadataError },
    { count: activeSourceMetadataCount, error: activeSourceMetadataError },
    { count: checkedSharedSourceCount, error: checkedSharedSourceError },
    { count: checkedSharedSource24hCount, error: checkedSharedSource24hError },
    { count: checkedSharedSource48hCount, error: checkedSharedSource48hError },
    { count: checkedSharedSource7dCount, error: checkedSharedSource7dError },
    { data: latestCheckedSourceRows, error: latestCheckedSourceError },
    { count: visualSnapshotRecordCount, error: visualSnapshotRecordError },
  ] = await Promise.all([
    admin.from("local_worker_runs").select("*").order("started_at", { ascending: false }).limit(30),
    admin.from("shared_award_sources").select("*", { count: "exact", head: true }),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active"),
    admin
      .from("shared_award_sources")
      .select("*", { count: "exact", head: true })
      .not("page_metadata_generated_at", "is", null),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .not("page_metadata_generated_at", "is", null),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .not("last_checked_at", "is", null),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .gte("last_checked_at", checked24hCutoff),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .gte("last_checked_at", checked48hCutoff),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .gte("last_checked_at", checked7dCutoff),
    admin
      .from("shared_award_sources")
      .select("id, last_checked_at, shared_awards!inner(status)")
      .eq("shared_awards.status", "active")
      .not("last_checked_at", "is", null)
      .order("last_checked_at", { ascending: false })
      .limit(1),
    admin
      .from("shared_award_source_visual_snapshots")
      .select("*", { count: "exact", head: true }),
  ]);

  const workerRuns = (workerRunRows || []) as LocalWorkerRun[];
  const pageIssueReview = await loadAdminPageIssues(admin, workerRuns);
  const visualRuns = workerRuns.filter((run) => run.worker_name.includes("visual-snapshot"));
  const pageInfoRuns = workerRuns.filter((run) => run.worker_name.includes("baseline-facts"));
  const awardDetailRuns = workerRuns.filter((run) =>
    run.worker_name.includes("award-baseline-detail"),
  );
  const latestVisualRun = visualRuns[0] || null;
  const latestPageInfoRun = pageInfoRuns[0] || null;
  const latestAwardDetailRun = awardDetailRuns[0] || null;
  const latestVisualMetadata = latestVisualRun ? metadataObject(latestVisualRun.metadata) : {};
  const latestPageInfoMetadata = latestPageInfoRun
    ? metadataObject(latestPageInfoRun.metadata)
    : {};
  const latestAwardDetailMetadata = latestAwardDetailRun
    ? metadataObject(latestAwardDetailRun.metadata)
    : {};
  const latestCounts = objectValue(latestVisualMetadata.counts);
  const latestPageInfoCounts = objectValue(latestPageInfoMetadata.counts);
  const latestAwardDetailCounts = objectValue(latestAwardDetailMetadata.counts);
  const latestOptions = objectValue(latestVisualMetadata.options);
  const latestPageInfoOptions = latestPageInfoRun
    ? objectValue(latestPageInfoMetadata.options)
    : latestOptions;
  const latestAwardDetailOptions = objectValue(latestAwardDetailMetadata.options);
  const latestPipeline = objectValue(latestVisualMetadata.visual_pipeline);
  const latestPageInfoPipeline = latestPageInfoRun
    ? effectiveDetailPipeline(latestPageInfoMetadata)
    : latestPipeline;
  const latestAwardDetailPipeline = effectiveDetailPipeline(latestAwardDetailMetadata);
  const latestCapture = objectValue(latestPipeline.capture);
  const latestComparison = objectValue(latestPipeline.comparison);
  const latestPublishing = objectValue(latestPipeline.publishing);
  const latestPageInfoExtraction = objectValue(latestPageInfoPipeline.extraction);
  const latestAwardDetailExtraction = objectValue(latestAwardDetailPipeline.extraction);
  const latestAwardDetailPublishing = objectValue(latestAwardDetailPipeline.publishing);
  const latestPageInfoStatusRun = latestPageInfoRun || latestVisualRun;
  const latestGeminiCliUsage = objectValue(latestVisualMetadata.gemini_cli_usage);
  const latestGeminiUsage = objectValue(latestVisualMetadata.gemini_usage);
  const latestPageInfoGeminiUsage = latestPageInfoRun
    ? objectValue(latestPageInfoMetadata.gemini_usage)
    : latestGeminiUsage;
  const latestAwardDetailGeminiUsage = objectValue(latestAwardDetailMetadata.gemini_usage);
  const latestPageInfoApplied =
    numberFromObject(latestPageInfoExtraction, "backfilled") ||
    numberFromObject(latestPageInfoCounts, "applied") ||
    latestPageInfoRun?.changed_count ||
    0;
  const latestAwardDetailApplied =
    numberFromObject(latestAwardDetailPublishing, "applied") ||
    numberFromObject(latestAwardDetailCounts, "applied") ||
    latestAwardDetailRun?.changed_count ||
    0;
  const latestGeminiApiHealth = geminiApiHealth(latestGeminiUsage, latestOptions);
  const latestPageInfoGeminiApiHealth = geminiApiHealth(
    latestPageInfoGeminiUsage,
    latestPageInfoOptions,
  );
  const latestVisualChecked = numberFromObject(latestCapture, "checked") || latestVisualRun?.checked_count || 0;
  const latestVisualBaselined = numberFromObject(latestCapture, "baselined") || latestVisualRun?.initial_count || 0;
  const latestVisualUnchanged = numberFromObject(latestCapture, "unchanged") || latestVisualRun?.unchanged_count || 0;
  const latestVisualFailed = numberFromObject(latestCapture, "failed") || latestVisualRun?.failed_count || 0;
  const latestPageInfoBatchJobs = numberFromObject(latestPageInfoGeminiUsage, "batch_jobs");
  const latestPageInfoBatchRequests = numberFromObject(latestPageInfoGeminiUsage, "batch_requests");
  const latestPageInfoBatchFailures = numberFromObject(latestPageInfoGeminiUsage, "batch_failures");
  const latestPageInfoBatchCompleted = Math.min(
    latestPageInfoBatchRequests,
    numberFromObject(latestPageInfoGeminiUsage, "calls") + latestPageInfoBatchFailures,
  );
  const latestPageInfoBatchPending = Math.max(
    0,
    latestPageInfoBatchRequests - latestPageInfoBatchCompleted,
  );
  const latestPageInfoBatchPercent = percent(
    latestPageInfoBatchCompleted,
    latestPageInfoBatchRequests,
  );
  const latestPageInfoLoaded = numberFromObject(latestPageInfoCounts, "loaded_baselines");
  const latestPageInfoProcessed =
    numberFromObject(latestPageInfoCounts, "extracted") ||
    numberFromObject(latestPageInfoExtraction, "extracted") ||
    latestPageInfoRun?.initial_count ||
    0;
  const latestPageInfoSkipped =
    numberFromObject(latestPageInfoCounts, "skipped_existing") +
    numberFromObject(latestPageInfoCounts, "skipped_ineligible");
  const latestPageInfoRunCompleted = latestPageInfoProcessed + latestPageInfoSkipped;
  const latestPageInfoRunPercent = percent(latestPageInfoRunCompleted, latestPageInfoLoaded);
  const latestBaselineCoverage = baselineCoverageFromMetadata(latestVisualMetadata);
  const latestBaselinePace = baselinePaceFromMetadata(
    latestVisualRun,
    latestVisualMetadata,
    renderedAt,
  );
  const activeSourceTotal = activeSharedSourceCount || sharedSourceCount || 0;
  const publishedSnapshotCount = visualSnapshotRecordCount || 0;
  const publishedSnapshotMissing = Math.max(0, activeSourceTotal - publishedSnapshotCount);
  const publishedSnapshotPercent = percent(publishedSnapshotCount, activeSourceTotal);
  const activeSourceMetadataTotal = activeSourceMetadataCount || 0;
  const activeSourceMetadataMissing = Math.max(0, activeSourceTotal - activeSourceMetadataTotal);
  const activeSourceMetadataPercent = percent(activeSourceMetadataTotal, activeSourceTotal);
  const checkedSourceTotal = checkedSharedSourceCount || 0;
  const checkedSourcePercent = percent(checkedSourceTotal, activeSourceTotal);
  const checkedSource24h = checkedSharedSource24hCount || 0;
  const checkedSource48h = checkedSharedSource48hCount || 0;
  const checkedSource7d = checkedSharedSource7dCount || 0;
  const checkedSourceNever = Math.max(0, activeSourceTotal - checkedSourceTotal);
  const checkedSourceOlderThan7d = Math.max(0, checkedSourceTotal - checkedSource7d);
  const latestSourceCheckedAt = latestCheckedSourceRows?.[0]?.last_checked_at || null;
  const baselineCoveragePercent = latestBaselineCoverage
    ? percent(latestBaselineCoverage.existingBaselines, latestBaselineCoverage.loadedSources)
    : 0;
  const localBaselineLabel = latestBaselineCoverage
    ? `${formatNumber(latestBaselineCoverage.existingBaselines)} of ${formatNumber(latestBaselineCoverage.loadedSources)} local`
    : `${formatNumber(publishedSnapshotCount)} sources indexed in R2`;
  const latestVisualStage = visualRunStage(latestVisualRun, latestVisualMetadata);
  const pageIssueSummary = pageIssueReview.summary;
  const topPageIssues = pageIssueReview.issues.slice(0, 6);
  const pipelineErrors = [
    workerRunError?.message,
    sharedSourceError?.message,
    activeSharedSourceError?.message,
    sourceMetadataError?.message,
    activeSourceMetadataError?.message,
    checkedSharedSourceError?.message,
    checkedSharedSource24hError?.message,
    checkedSharedSource48hError?.message,
    checkedSharedSource7dError?.message,
    latestCheckedSourceError?.message,
    visualSnapshotRecordError?.message,
    ...pageIssueReview.loadErrors,
  ].filter(Boolean);
  const sourceMetadataPercent = percent(sourceMetadataCount || 0, sharedSourceCount || 0);

  return (
    <AdminShell>
      <div className="admin-page-header">
        <div>
          <span className="badge">Admin</span>
          <h1 className="admin-page-title">Screenshot scans</h1>
          <p className="admin-page-copy">
            Owner-only status for the daily local worker that captures screenshots, stores snapshots
            in R2, scans pages for award information, compares changes, and publishes meaningful updates.
          </p>
          <p className="admin-page-timestamp">
            Page data refreshed {formatDate(renderedAt)}.
          </p>
        </div>
        <AdminAutoRefresh intervalSeconds={30} />
      </div>

      {pipelineErrors.length > 0 && (
        <section className="mb-6 card border-[var(--brand-pink)] p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <h2 className="font-black">Some scan data could not be loaded</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">{pipelineErrors.join(" ")}</p>
            </div>
          </div>
        </section>
      )}

      <section className="admin-metric-grid admin-metric-grid-primary">
        <MetricCard
          icon={Eye}
          label="Daily worker"
          value={latestVisualRun ? statusLabel(latestVisualRun.status) : "None"}
          detail={latestVisualRun ? latestVisualStage : "No run logged"}
          attention={latestVisualRun?.status === "failed"}
        />
        <MetricCard
          icon={Database}
          label="Screenshot baselines"
          value={latestBaselineCoverage ? `${baselineCoveragePercent}%` : formatNumber(visualSnapshotRecordCount || 0)}
          detail={
            latestBaselineCoverage
              ? `${localBaselineLabel}; ${formatNumber(publishedSnapshotMissing)} unpublished to R2`
              : localBaselineLabel
          }
          attention={publishedSnapshotMissing > 0}
        />
        <MetricCard
          icon={Sparkles}
          label="Info coverage"
          value={`${activeSourceMetadataPercent}%`}
          detail={`${formatNumber(activeSourceMetadataTotal)} of ${formatNumber(activeSourceTotal)} active pages have extracted information`}
          attention={activeSourceMetadataMissing > 0}
        />
        <MetricCard
          icon={Sparkles}
          label="Batch work"
          value={latestPageInfoBatchRequests > 0 ? `${latestPageInfoBatchPercent}%` : "None"}
          detail={
            latestPageInfoBatchRequests > 0
              ? `${formatNumber(latestPageInfoBatchCompleted)} complete, ${formatNumber(latestPageInfoBatchPending)} pending; ${latestPageInfoGeminiApiHealth.metricDetail}`
              : latestPageInfoGeminiApiHealth.metricDetail
          }
          attention={latestPageInfoGeminiApiHealth.attention || latestPageInfoBatchFailures > 0}
        />
        <MetricCard
          icon={Clock3}
          label="Baseline checks"
          value={`${checkedSourcePercent}%`}
          detail={`${formatNumber(checkedSource24h)} checked in 24h; latest ${latestSourceCheckedAt ? formatDate(latestSourceCheckedAt) : "never"}`}
          attention={checkedSourceNever > 0}
        />
        <MetricCard
          icon={AlertTriangle}
          label="Page issues"
          value={formatNumber(pageIssueSummary.queueTotal)}
          detail={`${formatNumber(pageIssueSummary.persistentSourceErrors)} repeated failures; ${formatNumber(pageIssueSummary.recentWorkerPageErrors)} recent worker page errors`}
          attention={pageIssueSummary.queueTotal > 0 || pageIssueSummary.recentWorkerPageErrors > 0}
        />
      </section>

      <section className="card admin-section-card admin-issue-panel">
        <div className="admin-panel-heading">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} aria-hidden="true" />
            <h2>Page issue review</h2>
          </div>
          <Link className="button button-secondary" href="/dashboard/admin/issues">
            Open full queue
          </Link>
        </div>
        <div className="admin-stat-grid admin-stat-grid-compact">
          <MiniStat label="Source errors" value={pageIssueSummary.sourceErrors} attention={pageIssueSummary.sourceErrors > 0} />
          <MiniStat label="Repeated failures" value={pageIssueSummary.persistentSourceErrors} attention={pageIssueSummary.persistentSourceErrors > 0} />
          <MiniStat label="Award detail errors" value={pageIssueSummary.awardStructureErrors} attention={pageIssueSummary.awardStructureErrors > 0} />
          <MiniStat label="Missing snapshots" value={pageIssueSummary.missingSnapshots} attention={pageIssueSummary.missingSnapshots > 0} />
          <MiniStat label="Missing page info" value={pageIssueSummary.missingPageInfo} attention={pageIssueSummary.missingPageInfo > 0} />
        </div>
        {topPageIssues.length > 0 ? (
          <div className="admin-issue-list admin-issue-list-compact">
            {topPageIssues.map((issue) => (
              <CompactIssueRow issue={issue} key={issue.key} />
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm font-semibold text-[var(--muted)]">
            No active page issues are currently reported.
          </p>
        )}
      </section>

      <section className="admin-dashboard-grid">
        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Eye size={18} aria-hidden="true" />
              <h2>Screenshot and R2</h2>
            </div>
            <StatusPill status={latestVisualRun?.status || "running"} />
          </div>
          {latestBaselineCoverage && (
            <ProgressBar
              label="Screenshot baseline coverage"
              value={baselineCoveragePercent}
              detail={`${formatNumber(latestBaselineCoverage.existingBaselines)} baselined, ${formatNumber(latestBaselineCoverage.missingBaselines)} missing.`}
            />
          )}
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Checked" value={latestVisualChecked} />
            <MiniStat label="Baselined" value={latestVisualBaselined} />
            <MiniStat label="Failed" value={latestVisualFailed} attention={latestVisualFailed > 0} />
            <MiniStat label="R2 uploaded" value={numberFromObject(latestCounts, "r2_uploaded")} />
            <MiniStat label="Unpublished" value={publishedSnapshotMissing} attention={publishedSnapshotMissing > 0} />
            <MiniStat label="Done this run" value={latestBaselinePace?.completedThisRun || 0} />
          </div>
          <DetailDisclosure label="More scan details">
            <div className="admin-stat-grid admin-stat-grid-compact">
              <MiniStat label="Unchanged" value={latestVisualUnchanged} />
              <MiniStat label="R2 rotated" value={numberFromObject(latestCounts, "r2_rotated")} />
              <MiniStat label="R2 failed" value={numberFromObject(latestCounts, "r2_failed")} attention={numberFromObject(latestCounts, "r2_failed") > 0} />
              <MiniStat label="Published rows" value={publishedSnapshotCount} />
            </div>
            <dl className="admin-detail-grid admin-detail-grid-tight">
              <Detail label="Stage" value={latestVisualStage} />
              <Detail label="Started" value={latestVisualRun ? formatDate(latestVisualRun.started_at) : "None"} />
              <Detail label="Finished" value={latestVisualRun?.finished_at ? formatDate(latestVisualRun.finished_at) : "Still running"} />
              <Detail label="R2 sync" value={booleanFromObject(latestOptions, "r2_snapshot_sync") ? "On" : "Off"} />
              <Detail label="Bucket" value={stringFromObject(latestOptions, "r2_bucket") || "Not set"} />
              <Detail label="R2 coverage" value={`${publishedSnapshotPercent}% of active sources`} />
            </dl>
          </DetailDisclosure>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Sparkles size={18} aria-hidden="true" />
              <h2>Gemini page information</h2>
            </div>
            <span className={latestPageInfoGeminiApiHealth.attention ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {latestPageInfoGeminiApiHealth.label}
            </span>
          </div>
          <div className="admin-progress-stack">
            <ProgressBar
              label="Information coverage"
              value={activeSourceMetadataPercent}
              detail={`${formatNumber(activeSourceMetadataTotal)} of ${formatNumber(activeSourceTotal)} active source pages have extracted page facts.`}
            />
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Pages with info" value={activeSourceMetadataTotal} />
            <MiniStat label="Pages missing info" value={activeSourceMetadataMissing} attention={activeSourceMetadataMissing > 0} />
            <MiniStat label="Batch pending" value={latestPageInfoBatchPending} attention={latestPageInfoBatchPending > 0} />
            <MiniStat label="Batch failed" value={latestPageInfoBatchFailures} attention={latestPageInfoBatchFailures > 0} />
            <MiniStat label="API calls" value={numberFromObject(latestPageInfoGeminiUsage, "calls")} />
            <MiniStat label="API cost" value={`$${formatUsd(numberFromObjectFloat(latestPageInfoGeminiUsage, "estimated_cost_usd"))}`} />
          </div>
          <DetailDisclosure label="More Gemini details">
            <div className="admin-progress-stack">
              {latestPageInfoBatchRequests > 0 && (
                <ProgressBar
                  label="Current batch completion"
                  value={latestPageInfoBatchPercent}
                  detail={`${formatNumber(latestPageInfoBatchCompleted)} of ${formatNumber(latestPageInfoBatchRequests)} batch requests complete; ${formatNumber(latestPageInfoBatchPending)} pending.`}
                />
              )}
              {latestPageInfoLoaded > 0 && (
                <ProgressBar
                  label="Latest page-info run"
                  value={latestPageInfoRunPercent}
                  detail={`${formatNumber(latestPageInfoRunCompleted)} of ${formatNumber(latestPageInfoLoaded)} loaded local baselines processed in this run.`}
                />
              )}
            </div>
            <div className="admin-stat-grid admin-stat-grid-compact">
              <MiniStat label="Extracted" value={numberFromObject(latestPageInfoExtraction, "extracted")} />
              <MiniStat label="Applied" value={latestPageInfoApplied} />
              <MiniStat label="Batch jobs" value={latestPageInfoBatchJobs} />
              <MiniStat label="Batch submitted" value={latestPageInfoBatchRequests} />
              <MiniStat label="Batch complete" value={latestPageInfoBatchCompleted} />
              <MiniStat label="Cost cap" value={formatApiCostCap(latestPageInfoOptions)} />
            </div>
            <dl className="admin-detail-grid admin-detail-grid-tight">
              <Detail label="Provider" value={latestPageInfoStatusRun?.ai_provider || stringFromObject(latestPageInfoExtraction, "provider") || "None"} />
              <Detail label="Model" value={stringFromObject(latestPageInfoExtraction, "model") || stringFromObject(latestPageInfoMetadata, "ai_model") || stringFromObject(latestVisualMetadata, "ai_model") || "None"} />
              <Detail label="API mode" value={stringFromObject(latestPageInfoGeminiUsage, "api_mode") || stringFromObject(latestPageInfoOptions, "gemini_api_mode") || "Immediate"} />
              <Detail label="Daily page scan" value={booleanFromObject(latestPageInfoOptions, "extract_baseline_info") || latestPageInfoStatusRun?.status === "running" ? "On" : "Off"} />
              {latestPageInfoGeminiApiHealth.errorDetail && (
                <Detail label="Last API error" value={latestPageInfoGeminiApiHealth.errorDetail} />
              )}
            </dl>
          </DetailDisclosure>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Database size={18} aria-hidden="true" />
              <h2>Coverage and freshness</h2>
            </div>
          </div>
          <ProgressBar
            label="Baseline comparison coverage"
            value={checkedSourcePercent}
            detail={`${formatNumber(checkedSourceTotal)} active source pages have been checked at least once.`}
          />
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Active sources" value={activeSourceTotal} />
            <MiniStat label="Active info scanned" value={`${formatNumber(activeSourceMetadataTotal)} (${activeSourceMetadataPercent}%)`} />
            <MiniStat label="Checked 24h" value={checkedSource24h} />
            <MiniStat label="Checked 7d" value={checkedSource7d} />
            <MiniStat label="Older than 7d" value={checkedSourceOlderThan7d} attention={checkedSourceOlderThan7d > 0} />
            <MiniStat label="Never checked" value={checkedSourceNever} attention={checkedSourceNever > 0} />
            <MiniStat label="Actionable missing" value={latestBaselineCoverage?.actionableMissingBaselines || 0} attention={Boolean(latestBaselineCoverage?.actionableMissingBaselines)} />
          </div>
          <DetailDisclosure label="More coverage details">
            <div className="admin-stat-grid admin-stat-grid-compact">
              <MiniStat label="Catalog sources" value={sharedSourceCount || 0} />
              <MiniStat label="All info scanned" value={`${formatNumber(sourceMetadataCount || 0)} (${sourceMetadataPercent}%)`} />
              <MiniStat label="Checked ever" value={`${formatNumber(checkedSourceTotal)} (${checkedSourcePercent}%)`} />
              <MiniStat label="Checked 48h" value={checkedSource48h} />
              <MiniStat label="Known broken missing" value={latestBaselineCoverage?.knownBrokenMissingBaselines || 0} attention={Boolean(latestBaselineCoverage?.knownBrokenMissingBaselines)} />
            </div>
            <dl className="admin-detail-grid admin-detail-grid-tight">
              <Detail label="Latest source check" value={latestSourceCheckedAt ? formatDate(latestSourceCheckedAt) : "None yet"} />
              <Detail label="Checked in last 24h" value={`${formatNumber(checkedSource24h)} of ${formatNumber(activeSourceTotal)}`} />
              <Detail label="Checked in last 48h" value={`${formatNumber(checkedSource48h)} of ${formatNumber(activeSourceTotal)}`} />
              <Detail label="Checked in last 7d" value={`${formatNumber(checkedSource7d)} of ${formatNumber(activeSourceTotal)}`} />
            </dl>
          </DetailDisclosure>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Activity size={18} aria-hidden="true" />
              <h2>Change workflow</h2>
            </div>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Candidates" value={numberFromObject(latestComparison, "candidates")} />
            <MiniStat label="True changes" value={numberFromObject(latestComparison, "true_changes")} />
            <MiniStat label="Published" value={numberFromObject(latestPublishing, "published_updates")} />
            <MiniStat label="Publish failed" value={numberFromObject(latestPublishing, "failed")} attention={numberFromObject(latestPublishing, "failed") > 0} />
          </div>
          <DetailDisclosure label="Pipeline details">
            <div className="admin-stat-grid admin-stat-grid-compact">
              <MiniStat label="Interpreted" value={numberFromObject(latestComparison, "interpreted")} />
              <MiniStat label="Needs review" value={numberFromObject(latestComparison, "review")} />
              <MiniStat label="Duplicates" value={numberFromObject(latestPublishing, "duplicate_updates")} />
            </div>
            <div className="admin-flow-list admin-flow-list-compact">
              <PipelineRow
                icon={Eye}
                title="Capture"
                detail={`Checked ${formatNumber(latestVisualChecked)}, baselined ${formatNumber(latestVisualBaselined)}, failed ${formatNumber(latestVisualFailed)}.`}
                status={latestVisualRun ? statusLabel(latestVisualRun.status) : "Waiting"}
              />
              <PipelineRow
                icon={Sparkles}
                title="Extract page info"
                detail={`${formatNumber(activeSourceMetadataTotal)} of ${formatNumber(activeSourceTotal)} active pages covered. Batch pending: ${formatNumber(latestPageInfoBatchPending)}.`}
                status={latestPageInfoStatusRun?.status === "running" ? "Running" : "Idle"}
                attention={numberFromObject(latestPageInfoExtraction, "failed") > 0}
              />
              <PipelineRow
                icon={Activity}
                title="Interpret differences"
                detail={`${formatNumber(numberFromObject(latestComparison, "candidates"))} candidates, ${formatNumber(numberFromObject(latestComparison, "true_changes"))} meaningful changes.`}
                status={`${formatNumber(numberFromObject(latestComparison, "true_changes"))} true`}
              />
              <PipelineRow
                icon={Database}
                title="Publish"
                detail={`${formatNumber(numberFromObject(latestPublishing, "published_updates"))} published, ${formatNumber(numberFromObject(latestPublishing, "duplicate_updates"))} duplicates ignored.`}
                status={numberFromObject(latestPublishing, "failed") > 0 ? "Needs attention" : "Ready"}
                attention={numberFromObject(latestPublishing, "failed") > 0}
              />
            </div>
          </DetailDisclosure>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Eye size={18} aria-hidden="true" />
              <h2>Capture quality</h2>
            </div>
          </div>
          <div className="admin-stat-grid admin-stat-grid-compact">
            <MiniStat label="Expanded controls" value={numberFromObject(latestCounts, "expanded_controls")} />
            <MiniStat label="Ready timeouts" value={numberFromObject(latestCounts, "page_ready_timeouts")} attention={numberFromObject(latestCounts, "page_ready_timeouts") > 0} />
            <MiniStat label="Blocked pages" value={numberFromObject(latestCounts, "blocked_page_captures")} attention={numberFromObject(latestCounts, "blocked_page_captures") > 0} />
            <MiniStat label="PDFs checked" value={numberFromObject(latestCounts, "pdf_checked")} />
            <MiniStat label="PDFs changed" value={numberFromObject(latestCounts, "pdf_changed")} />
          </div>
          <DetailDisclosure label="More quality details">
            <div className="admin-stat-grid admin-stat-grid-compact">
              <MiniStat label="Refreshed captures" value={numberFromObject(latestCounts, "capture_behavior_refreshed")} />
              <MiniStat label="Discovered PDFs" value={numberFromObject(latestCounts, "discovered_pdf_sources")} />
              <MiniStat label="Page ready waits" value={numberFromObject(latestCounts, "page_ready_waits")} />
            </div>
            <dl className="admin-detail-grid admin-detail-grid-tight">
              <Detail label="AI provider" value={latestVisualRun?.ai_provider || "none"} />
              <Detail label="AI model" value={stringFromObject(latestVisualMetadata, "ai_model") || "none"} />
              <Detail label="API status" value={latestGeminiApiHealth.label} />
              <Detail label="API tokens" value={formatNumber(numberFromObject(latestGeminiUsage, "total_tokens"))} />
              <Detail label="CLI image files" value={formatNumber(numberFromObject(latestGeminiCliUsage, "image_files"))} />
              <Detail label="CLI elapsed" value={`${formatNumber(numberFromObject(latestGeminiCliUsage, "elapsed_ms"))} ms`} />
            </dl>
          </DetailDisclosure>
        </div>

        <div className="card admin-section-card admin-dashboard-card">
          <div className="admin-panel-heading">
            <div className="flex items-center gap-2">
              <Sparkles size={18} aria-hidden="true" />
              <h2>Award detail summaries</h2>
            </div>
            {latestAwardDetailRun && <StatusPill status={latestAwardDetailRun.status} />}
          </div>
          {latestAwardDetailRun ? (
            <>
              <div className="admin-stat-grid admin-stat-grid-compact">
                <MiniStat label="Awards checked" value={latestAwardDetailRun.checked_count || 0} />
                <MiniStat label="Details extracted" value={numberFromObject(latestAwardDetailExtraction, "extracted")} />
                <MiniStat label="Summaries applied" value={latestAwardDetailApplied} />
                <MiniStat label="No baseline yet" value={numberFromObject(latestAwardDetailExtraction, "no_baseline")} attention={numberFromObject(latestAwardDetailExtraction, "no_baseline") > 0} />
              </div>
              <DetailDisclosure label="More award details">
                <div className="admin-stat-grid admin-stat-grid-compact">
                  <MiniStat label="Skipped existing" value={numberFromObject(latestAwardDetailCounts, "skipped_existing")} />
                  <MiniStat label="API cost" value={`$${formatUsd(numberFromObjectFloat(latestAwardDetailGeminiUsage, "estimated_cost_usd"))}`} />
                </div>
                <dl className="admin-detail-grid admin-detail-grid-tight">
                  <Detail label="Started" value={formatDate(latestAwardDetailRun.started_at)} />
                  <Detail label="Finished" value={latestAwardDetailRun.finished_at ? formatDate(latestAwardDetailRun.finished_at) : "Still running"} />
                  <Detail label="AI model" value={stringFromObject(latestAwardDetailMetadata, "ai_model") || "Source page facts"} />
                  <Detail label="API calls" value={formatNumber(numberFromObject(latestAwardDetailGeminiUsage, "calls"))} />
                  <Detail label="API cost cap" value={formatApiCostCap(latestAwardDetailOptions)} />
                  <Detail label="CLI call cap" value={formatCap(latestAwardDetailOptions)} />
                </dl>
              </DetailDisclosure>
            </>
          ) : (
            <p className="text-sm text-[var(--muted)]">
              No baseline award-detail run has been recorded yet.
            </p>
          )}
        </div>
      </section>

    </AdminShell>
  );
}

function AdminShell({ children }: { children: React.ReactNode }) {
  return <div className="admin-page mx-auto w-full max-w-[90rem]">{children}</div>;
}

function AdminAccessDenied({ configured }: { configured: boolean }) {
  return (
    <AdminShell>
      <div className="card p-6">
        <span className="badge">Admin</span>
        <h1 className="mt-4 text-3xl font-black">Screenshot scans</h1>
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
  icon: typeof Activity;
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

function CompactIssueRow({ issue }: { issue: AdminPageIssue }) {
  return (
    <article className={`admin-issue-row admin-issue-row-${issue.severity}`}>
      <div className="min-w-0">
        <div className="admin-issue-meta">
          <span className={`admin-severity-pill admin-severity-pill-${issue.severity}`}>
            {issue.severity}
          </span>
          <span>{issue.area}</span>
          <span>{issue.label}</span>
          {issue.failures > 0 && <span>{formatNumber(issue.failures)} failures</span>}
        </div>
        <h3>{issue.awardName}</h3>
        <p className="admin-issue-source">{issue.sourceTitle}</p>
        <p className="admin-issue-message">{issue.message}</p>
      </div>
      {issue.awardId && (
        <Link className="admin-issue-link" href={`/dashboard/awards/${issue.awardId}`}>
          Open
        </Link>
      )}
    </article>
  );
}

function ProgressBar({
  label,
  value,
  detail,
  className = "",
}: {
  label: string;
  value: number;
  detail: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-3 text-xs font-bold text-[var(--muted)]">
        <span>{label}</span>
        <span>{value}%</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--brand-blue-soft)]">
        <div className="h-full rounded-full bg-[var(--brand)]" style={{ width: `${value}%` }} />
      </div>
      <p className="mt-1.5 text-xs font-semibold text-[var(--muted)]">{detail}</p>
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

function effectiveDetailPipeline(metadata: Record<string, unknown>) {
  const detailPipeline = objectValue(metadata.detail_pipeline);
  if (Object.keys(detailPipeline).length > 0) return detailPipeline;
  return objectValue(metadata.visual_pipeline);
}

function visualRunStage(run: LocalWorkerRun | null, metadata: Record<string, unknown>) {
  if (!run) return "No run logged";
  if (run.status === "succeeded") return "Finished";
  if (run.status === "failed") return "Failed";

  const counts = objectValue(metadata.counts);
  const pipeline = objectValue(metadata.visual_pipeline);
  const extraction = objectValue(pipeline.extraction);
  const publishing = objectValue(pipeline.publishing);
  const options = objectValue(metadata.options);
  const geminiCliUsage = objectValue(metadata.gemini_cli_usage);
  const geminiUsage = objectValue(metadata.gemini_usage);

  if (geminiApiHealth(geminiUsage, options).blocked) {
    return "Running: screenshots and R2, Gemini API billing blocked";
  }
  if (geminiApiCapReached(options, geminiUsage) || geminiCapReached(options, geminiCliUsage)) {
    return "Running: screenshots and R2, Gemini cap reached";
  }
  if (numberFromObject(extraction, "extracted") > 0) {
    return "Running: scanning pages for award information";
  }
  if (numberFromObject(counts, "r2_uploaded") > 0) {
    return "Running: refreshing screenshots in R2";
  }
  if (numberFromObject(publishing, "published_updates") > 0) {
    return "Running: publishing updates";
  }
  return "Running";
}

function geminiCapReached(options: Record<string, unknown>, usage: Record<string, unknown>) {
  const cap = numberFromObject(options, "gemini_cli_max_calls");
  if (cap <= 0) return false;
  return numberFromObject(usage, "calls") >= cap;
}

function geminiApiCapReached(options: Record<string, unknown>, usage: Record<string, unknown>) {
  const callCap = numberFromObject(options, "gemini_api_max_calls");
  const costCap = numberFromObjectFloat(options, "gemini_api_daily_cost_cap_usd");
  const callsReached = callCap > 0 && numberFromObject(usage, "calls") >= callCap;
  const costReached =
    costCap > 0 && numberFromObjectFloat(usage, "estimated_cost_usd") >= costCap;
  return callsReached || costReached;
}

function geminiApiHealth(usage: Record<string, unknown>, options: Record<string, unknown>) {
  const lastError = objectValue(usage.last_error);
  const status = stringFromObject(usage, "status");
  const blocked = status === "blocked" || lastError.blocked === true;
  const capReached = geminiApiCapReached(options, usage);
  const estimatedCost = `~$${formatUsd(numberFromObjectFloat(usage, "estimated_cost_usd"))} estimated`;
  const cap = `cap ${formatApiCostCap(options)}`;
  const errorMessage = stringFromObject(lastError, "message");
  const errorDetail = errorMessage
    ? `${stringFromObject(lastError, "provider_status") || `HTTP ${formatNumber(numberFromObject(lastError, "http_status"))}`}: ${errorMessage}`
    : "";

  if (blocked) {
    return {
      label: "Blocked: API billing/prepay",
      metricDetail: `${estimatedCost}, ${cap}; API billing needs attention`,
      errorDetail,
      attention: true,
      blocked: true,
    };
  }
  if (capReached) {
    return {
      label: "Cap reached",
      metricDetail: `${estimatedCost}, ${cap}; worker will skip extra Gemini calls`,
      errorDetail,
      attention: true,
      blocked: false,
    };
  }
  if (status === "error") {
    return {
      label: "Last call failed",
      metricDetail: `${estimatedCost}, ${cap}; check last API error`,
      errorDetail,
      attention: true,
      blocked: false,
    };
  }

  return {
    label: numberFromObject(usage, "calls") > 0 ? "Ready" : "Ready, no calls this run",
    metricDetail: `${estimatedCost}, ${cap}`,
    errorDetail,
    attention: false,
    blocked: false,
  };
}

function formatCap(options: Record<string, unknown>) {
  const cap = numberFromObject(options, "gemini_cli_max_calls");
  return cap > 0 ? formatNumber(cap) : "No cap";
}

function formatApiCostCap(options: Record<string, unknown>) {
  const cap = numberFromObjectFloat(options, "gemini_api_daily_cost_cap_usd");
  return cap > 0 ? `$${formatUsd(cap)}` : "No cap";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatUsd(value: number) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: 4,
  });
}

function percent(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

function baselinePaceFromMetadata(
  run: LocalWorkerRun | null,
  metadata: Record<string, unknown>,
  nowIso: string,
): BaselinePace | null {
  if (!run) return null;

  const coverage = objectValue(metadata.baseline_coverage);
  const start = baselineCoverageFromObject(objectValue(coverage.start));
  const current = baselineCoverageFromMetadata(metadata);
  if (!start || !current) return null;

  const startedAtMs = new Date(run.started_at).getTime();
  const nowMs = new Date(nowIso).getTime();
  const elapsedHours = (nowMs - startedAtMs) / 3_600_000;
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) return null;

  const completedThisRun = Math.max(0, current.existingBaselines - start.existingBaselines);
  if (completedThisRun <= 0) return null;

  const pagesPerHour = completedThisRun / elapsedHours;
  const remainingHours =
    pagesPerHour > 0 ? current.actionableMissingBaselines / pagesPerHour : null;

  return {
    completedThisRun,
    pagesPerHour,
    etaLabel: remainingHours === null ? "Unknown" : formatDurationHours(remainingHours),
    elapsedLabel: formatDurationHours(elapsedHours),
  };
}

function formatDurationHours(hours: number) {
  if (!Number.isFinite(hours) || hours < 0) return "Unknown";
  if (hours < 1) {
    return `${Math.max(1, Math.round(hours * 60))}m`;
  }

  const wholeHours = Math.floor(hours);
  const minutes = Math.round((hours - wholeHours) * 60);
  if (wholeHours >= 24) {
    const days = Math.floor(wholeHours / 24);
    const remainderHours = wholeHours % 24;
    return remainderHours > 0 ? `${days}d ${remainderHours}h` : `${days}d`;
  }
  return minutes > 0 ? `${wholeHours}h ${minutes}m` : `${wholeHours}h`;
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

function numberFromObjectFloat(value: Record<string, unknown>, key: string) {
  const number = Number(value[key]);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function booleanFromObject(value: Record<string, unknown>, key: string) {
  return value[key] === true;
}

function stringFromObject(value: Record<string, unknown>, key: string) {
  const raw = value[key];
  return typeof raw === "string" ? raw : "";
}

function baselineCoverageFromMetadata(metadata: Record<string, unknown>): BaselineCoverage | null {
  const coverage = objectValue(metadata.baseline_coverage);
  const finish = objectValue(coverage.finish);
  const progress = objectValue(coverage.progress);
  const start = objectValue(coverage.start);
  const selected =
    Object.keys(finish).length > 0 ? finish : Object.keys(progress).length > 0 ? progress : start;
  return baselineCoverageFromObject(selected);
}

function baselineCoverageFromObject(selected: Record<string, unknown>): BaselineCoverage | null {
  const loadedSources = numberFromObject(selected, "loaded_sources");
  if (loadedSources <= 0) return null;

  return {
    loadedSources,
    existingBaselines: numberFromObject(selected, "existing_baselines"),
    missingBaselines: numberFromObject(selected, "missing_baselines"),
    actionableMissingBaselines: numberFromObject(selected, "actionable_missing_baselines"),
    knownBrokenMissingBaselines: numberFromObject(selected, "known_broken_missing_baselines"),
  };
}
