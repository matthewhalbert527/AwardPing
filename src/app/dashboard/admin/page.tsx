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
  const [
    { data: workerRunRows, error: workerRunError },
    { count: sharedSourceCount, error: sharedSourceError },
    { count: activeSharedSourceCount, error: activeSharedSourceError },
    { count: sourceMetadataCount, error: sourceMetadataError },
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
      .from("shared_award_source_visual_snapshots")
      .select("*", { count: "exact", head: true }),
  ]);

  const workerRuns = (workerRunRows || []) as LocalWorkerRun[];
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
  const latestPageInfoGeminiCliUsage = latestPageInfoRun
    ? objectValue(latestPageInfoMetadata.gemini_cli_usage)
    : latestGeminiCliUsage;
  const latestAwardDetailGeminiCliUsage = objectValue(
    latestAwardDetailMetadata.gemini_cli_usage,
  );
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
  const latestBaselineCoverage = baselineCoverageFromMetadata(latestVisualMetadata);
  const renderedAt = new Date().toISOString();
  const latestBaselinePace = baselinePaceFromMetadata(
    latestVisualRun,
    latestVisualMetadata,
    renderedAt,
  );
  const activeSourceTotal = activeSharedSourceCount || sharedSourceCount || 0;
  const publishedSnapshotCount = visualSnapshotRecordCount || 0;
  const publishedSnapshotMissing = Math.max(0, activeSourceTotal - publishedSnapshotCount);
  const publishedSnapshotPercent = percent(publishedSnapshotCount, activeSourceTotal);
  const baselineCoveragePercent = latestBaselineCoverage
    ? percent(latestBaselineCoverage.existingBaselines, latestBaselineCoverage.loadedSources)
    : 0;
  const localBaselineLabel = latestBaselineCoverage
    ? `${formatNumber(latestBaselineCoverage.existingBaselines)} of ${formatNumber(latestBaselineCoverage.loadedSources)} local`
    : `${formatNumber(publishedSnapshotCount)} sources indexed in R2`;
  const latestVisualStage = visualRunStage(latestVisualRun, latestVisualMetadata);
  const pipelineErrors = [
    workerRunError?.message,
    sharedSourceError?.message,
    activeSharedSourceError?.message,
    sourceMetadataError?.message,
    visualSnapshotRecordError?.message,
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

      <section className="admin-metric-grid">
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
          label="Gemini API calls"
          value={formatNumber(numberFromObject(latestPageInfoGeminiUsage, "calls"))}
          detail={latestPageInfoGeminiApiHealth.metricDetail}
          attention={latestPageInfoGeminiApiHealth.attention}
        />
        <MetricCard
          icon={Database}
          label="R2 uploads"
          value={formatNumber(numberFromObject(latestCounts, "r2_uploaded"))}
          detail={`${formatNumber(numberFromObject(latestCounts, "r2_rotated"))} rotated, ${formatNumber(numberFromObject(latestCounts, "r2_failed"))} failed`}
          attention={numberFromObject(latestCounts, "r2_failed") > 0}
        />
        <MetricCard
          icon={Sparkles}
          label="Award details"
          value={latestAwardDetailRun ? statusLabel(latestAwardDetailRun.status) : "None"}
          detail={
            latestAwardDetailRun
              ? `${formatNumber(numberFromObject(latestAwardDetailExtraction, "extracted"))} extracted, ${formatNumber(latestAwardDetailApplied)} applied`
              : "No detail run logged"
          }
          attention={latestAwardDetailRun?.status === "failed"}
        />
        <MetricCard
          icon={Activity}
          label="Published updates"
          value={formatNumber(numberFromObject(latestPublishing, "published_updates"))}
          detail={`${formatNumber(numberFromObject(latestComparison, "true_changes"))} meaningful changes in latest run`}
          attention={numberFromObject(latestPublishing, "failed") > 0}
        />
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="card admin-section-card">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Eye size={18} aria-hidden="true" />
                <h2 className="text-2xl font-black">Daily screenshot pipeline</h2>
              </div>
              <p className="mt-2 text-sm text-[var(--muted)]">
                One local PC worker captures screenshots and PDFs. Gemini is used for separate
                page-information backfills and pages/PDFs that already look different.
              </p>
            </div>
            <StatusPill status={latestVisualRun?.status || "running"} />
          </div>

          <div className="admin-stat-grid admin-stat-grid-wide">
            <MiniStat label="Checked" value={latestVisualChecked} />
            <MiniStat label="Baselined" value={latestVisualBaselined} />
            <MiniStat label="Unchanged" value={latestVisualUnchanged} />
            <MiniStat label="Failed" value={latestVisualFailed} attention={latestVisualFailed > 0} />
            <MiniStat label="Facts extracted" value={numberFromObject(latestPageInfoExtraction, "extracted")} />
            <MiniStat label="Facts skipped" value={numberFromObject(latestPageInfoExtraction, "skipped")} attention={geminiApiCapReached(latestPageInfoOptions, latestPageInfoGeminiUsage) || geminiCapReached(latestPageInfoOptions, latestPageInfoGeminiCliUsage)} />
            <MiniStat label="Candidates" value={numberFromObject(latestComparison, "candidates")} />
            <MiniStat label="Interpreted" value={numberFromObject(latestComparison, "interpreted")} />
            <MiniStat label="Published" value={numberFromObject(latestPublishing, "published_updates")} />
            <MiniStat label="R2 uploaded" value={numberFromObject(latestCounts, "r2_uploaded")} />
            <MiniStat label="R2 failed" value={numberFromObject(latestCounts, "r2_failed")} attention={numberFromObject(latestCounts, "r2_failed") > 0} />
            <MiniStat label="Expanded controls" value={numberFromObject(latestCounts, "expanded_controls")} />
          </div>

          <div className="admin-flow-list">
            <PipelineRow
              icon={Eye}
              title="1. Capture screenshots and PDFs"
              detail={`Checked ${formatNumber(latestVisualChecked)}, baselined ${formatNumber(latestVisualBaselined)}, failed ${formatNumber(latestVisualFailed)}.`}
              status={latestVisualRun ? statusLabel(latestVisualRun.status) : "Waiting"}
            />
            <PipelineRow
              icon={Sparkles}
              title="2. Scan pages for award information"
              detail={`Extracted ${formatNumber(numberFromObject(latestPageInfoExtraction, "extracted"))}, applied ${formatNumber(latestPageInfoApplied)}, failed ${formatNumber(numberFromObject(latestPageInfoExtraction, "failed"))}.`}
              status={
                geminiApiCapReached(latestPageInfoOptions, latestPageInfoGeminiUsage) ||
                geminiCapReached(latestPageInfoOptions, latestPageInfoGeminiCliUsage)
                  ? "Cap reached"
                  : latestPageInfoStatusRun?.status === "running" ||
                      booleanFromObject(latestPageInfoExtraction, "enabled")
                    ? "On"
                    : "Off"
              }
              attention={
                numberFromObject(latestPageInfoExtraction, "failed") > 0 ||
                geminiApiCapReached(latestPageInfoOptions, latestPageInfoGeminiUsage) ||
                geminiCapReached(latestPageInfoOptions, latestPageInfoGeminiCliUsage)
              }
            />
            <PipelineRow
              icon={Activity}
              title="3. Compare and interpret differences"
              detail={`Candidates ${formatNumber(numberFromObject(latestComparison, "candidates"))}, interpreted ${formatNumber(numberFromObject(latestComparison, "interpreted"))}, review ${formatNumber(numberFromObject(latestComparison, "review"))}.`}
              status={`${formatNumber(numberFromObject(latestComparison, "true_changes"))} true`}
            />
            <PipelineRow
              icon={Database}
              title="4. Publish meaningful updates"
              detail={`Published ${formatNumber(numberFromObject(latestPublishing, "published_updates"))}, duplicates ignored ${formatNumber(numberFromObject(latestPublishing, "duplicate_updates"))}, failed ${formatNumber(numberFromObject(latestPublishing, "failed"))}.`}
              status={numberFromObject(latestPublishing, "failed") > 0 ? "Needs attention" : "Ready"}
              attention={numberFromObject(latestPublishing, "failed") > 0}
            />
          </div>

          <div className="mt-5 grid gap-4 xl:grid-cols-2">
            <div className="admin-subpanel">
              <h3 className="font-black">R2 snapshot storage</h3>
              <div className="admin-stat-grid admin-stat-grid-tight">
                <MiniStat label="Uploaded objects" value={numberFromObject(latestCounts, "r2_uploaded")} />
                <MiniStat label="Rotated objects" value={numberFromObject(latestCounts, "r2_rotated")} />
                <MiniStat label="Upload failures" value={numberFromObject(latestCounts, "r2_failed")} attention={numberFromObject(latestCounts, "r2_failed") > 0} />
                <MiniStat label="Skipped existing" value={numberFromObject(latestCounts, "r2_skipped_existing")} />
                <MiniStat label="Repaired missing" value={numberFromObject(latestCounts, "r2_repaired_missing")} />
                <MiniStat label="Known missing" value={numberFromObject(latestCounts, "r2_known_missing")} attention={numberFromObject(latestCounts, "r2_known_missing") > 0} />
                <MiniStat label="Published rows" value={publishedSnapshotCount} />
                <MiniStat label="Unpublished active" value={publishedSnapshotMissing} attention={publishedSnapshotMissing > 0} />
              </div>
              <dl className="admin-detail-grid">
                <Detail label="R2 sync" value={booleanFromObject(latestOptions, "r2_snapshot_sync") ? "On" : "Off"} />
                <Detail label="Repair missing" value={booleanFromObject(latestOptions, "r2_repair_missing_snapshots") ? "On" : "Off"} />
                <Detail label="Bucket" value={stringFromObject(latestOptions, "r2_bucket") || "Not set"} />
                <Detail label="R2 coverage" value={`${publishedSnapshotPercent}% of active sources`} />
              </dl>
            </div>

            <div className="admin-subpanel">
              <h3 className="font-black">Page information scan</h3>
              <div className="admin-stat-grid admin-stat-grid-tight">
                <MiniStat label="Extracted" value={numberFromObject(latestPageInfoExtraction, "extracted")} />
                <MiniStat label="Skipped" value={numberFromObject(latestPageInfoExtraction, "skipped")} attention={geminiApiCapReached(latestPageInfoOptions, latestPageInfoGeminiUsage) || geminiCapReached(latestPageInfoOptions, latestPageInfoGeminiCliUsage)} />
                <MiniStat label="Failed" value={numberFromObject(latestPageInfoExtraction, "failed")} attention={numberFromObject(latestPageInfoExtraction, "failed") > 0} />
                <MiniStat label="Applied" value={latestPageInfoApplied} />
              </div>
              <dl className="admin-detail-grid">
                <Detail label="Provider" value={latestPageInfoStatusRun?.ai_provider || stringFromObject(latestPageInfoExtraction, "provider") || "None"} />
                <Detail label="Model" value={stringFromObject(latestPageInfoExtraction, "model") || stringFromObject(latestPageInfoMetadata, "ai_model") || stringFromObject(latestVisualMetadata, "ai_model") || "None"} />
                <Detail label="Daily page scan" value={booleanFromObject(latestPageInfoOptions, "extract_baseline_info") || latestPageInfoStatusRun?.status === "running" ? "On" : "Off"} />
                <Detail label="API status" value={latestPageInfoGeminiApiHealth.label} />
                <Detail label="API calls" value={formatNumber(numberFromObject(latestPageInfoGeminiUsage, "calls"))} />
                <Detail label="Estimated API cost" value={`$${formatUsd(numberFromObjectFloat(latestPageInfoGeminiUsage, "estimated_cost_usd"))}`} />
                <Detail label="API cost cap" value={formatApiCostCap(latestPageInfoOptions)} />
                <Detail label="CLI call cap" value={formatCap(latestPageInfoOptions)} />
                {latestPageInfoGeminiApiHealth.errorDetail && (
                  <Detail label="Last API error" value={latestPageInfoGeminiApiHealth.errorDetail} />
                )}
              </dl>
            </div>
          </div>

          <div className="admin-subpanel">
            <h3 className="font-black">Screenshot behavior checks</h3>
            <div className="admin-stat-grid admin-stat-grid-wide">
              <MiniStat label="Refreshed captures" value={numberFromObject(latestCounts, "capture_behavior_refreshed")} />
              <MiniStat label="Expanded controls" value={numberFromObject(latestCounts, "expanded_controls")} />
              <MiniStat label="Discovered PDFs" value={numberFromObject(latestCounts, "discovered_pdf_sources")} />
              <MiniStat label="Page ready waits" value={numberFromObject(latestCounts, "page_ready_waits")} />
              <MiniStat label="Ready timeouts" value={numberFromObject(latestCounts, "page_ready_timeouts")} attention={numberFromObject(latestCounts, "page_ready_timeouts") > 0} />
              <MiniStat label="Blocked pages" value={numberFromObject(latestCounts, "blocked_page_captures")} attention={numberFromObject(latestCounts, "blocked_page_captures") > 0} />
              <MiniStat label="PDFs checked" value={numberFromObject(latestCounts, "pdf_checked")} />
              <MiniStat label="PDFs changed" value={numberFromObject(latestCounts, "pdf_changed")} />
            </div>
          </div>

          <div className="admin-subpanel">
            <h3 className="font-black">Latest run detail</h3>
            {latestVisualRun ? (
              <dl className="admin-detail-grid admin-detail-grid-wide">
                <Detail label="Started" value={formatDate(latestVisualRun.started_at)} />
                <Detail label="Finished" value={latestVisualRun.finished_at ? formatDate(latestVisualRun.finished_at) : "Still running"} />
                <Detail label="AI provider" value={latestVisualRun.ai_provider || "none"} />
                <Detail label="AI model" value={stringFromObject(latestVisualMetadata, "ai_model") || "none"} />
                <Detail label="Current stage" value={latestVisualStage} />
                <Detail label="Archive root" value={stringFromObject(latestVisualMetadata, "archive_root") || "Local worker default"} />
                <Detail label="Web workers" value={formatNumber(numberFromObject(latestOptions, "web_concurrency") || 1)} />
                <Detail label="Gemini API status" value={latestGeminiApiHealth.label} />
                <Detail label="Gemini API tokens" value={formatNumber(numberFromObject(latestGeminiUsage, "total_tokens"))} />
                <Detail label="Gemini CLI image files" value={formatNumber(numberFromObject(latestGeminiCliUsage, "image_files"))} />
                <Detail label="Gemini CLI elapsed" value={`${formatNumber(numberFromObject(latestGeminiCliUsage, "elapsed_ms"))} ms`} />
              </dl>
            ) : (
              <p className="mt-3 text-sm text-[var(--muted)]">
                No screenshot worker run has been recorded in Supabase yet.
              </p>
            )}
          </div>

          <div className="admin-subpanel">
            <h3 className="font-black">Baseline award details</h3>
            {latestAwardDetailRun ? (
              <>
                <div className="admin-stat-grid admin-stat-grid-wide">
                  <MiniStat label="Awards checked" value={latestAwardDetailRun.checked_count || 0} />
                  <MiniStat label="Skipped existing" value={numberFromObject(latestAwardDetailCounts, "skipped_existing")} />
                  <MiniStat label="Details extracted" value={numberFromObject(latestAwardDetailExtraction, "extracted")} />
                  <MiniStat label="Website summaries applied" value={latestAwardDetailApplied} />
                  <MiniStat
                    label="No baseline yet"
                    value={numberFromObject(latestAwardDetailExtraction, "no_baseline")}
                    attention={numberFromObject(latestAwardDetailExtraction, "no_baseline") > 0}
                  />
                </div>
                <dl className="admin-detail-grid admin-detail-grid-wide">
                  <Detail label="Started" value={formatDate(latestAwardDetailRun.started_at)} />
                  <Detail label="Finished" value={latestAwardDetailRun.finished_at ? formatDate(latestAwardDetailRun.finished_at) : "Still running"} />
                  <Detail label="AI model" value={stringFromObject(latestAwardDetailMetadata, "ai_model") || "Source page facts"} />
                  <Detail label="Gemini API calls" value={formatNumber(numberFromObject(latestAwardDetailGeminiUsage, "calls"))} />
                  <Detail label="Estimated API cost" value={`$${formatUsd(numberFromObjectFloat(latestAwardDetailGeminiUsage, "estimated_cost_usd"))}`} />
                  <Detail label="Gemini CLI calls" value={formatNumber(numberFromObject(latestAwardDetailGeminiCliUsage, "calls"))} />
                  <Detail label="Call cap" value={formatCap(latestAwardDetailOptions)} />
                  <Detail label="API cost cap" value={formatApiCostCap(latestAwardDetailOptions)} />
                  <Detail label="Safe models" value={formatSafeModels(latestAwardDetailOptions)} />
                  <Detail label="Unsafe override" value={booleanFromObject(latestAwardDetailOptions, "allow_unsafe_gemini_cli_model") ? "On" : "Off"} />
                </dl>
              </>
            ) : (
              <p className="mt-3 text-sm text-[var(--muted)]">
                No baseline award-detail run has been recorded yet.
              </p>
            )}
          </div>
        </div>

        <div className="card admin-section-card admin-side-card">
          <div className="flex items-center gap-2">
            <Database size={18} aria-hidden="true" />
            <h2 className="text-2xl font-black">Snapshot coverage</h2>
          </div>
          <div className="admin-stat-grid admin-stat-grid-side">
            <MiniStat label="Catalog source pages" value={sharedSourceCount || 0} />
            <MiniStat label="Active source pages" value={activeSourceTotal} />
            <MiniStat label="Page outlines scanned" value={`${formatNumber(sourceMetadataCount || 0)} (${sourceMetadataPercent}%)`} />
            <MiniStat label="R2 snapshot rows" value={publishedSnapshotCount} />
            <MiniStat label="Unpublished active" value={publishedSnapshotMissing} attention={publishedSnapshotMissing > 0} />
            <MiniStat label="Actionable missing" value={latestBaselineCoverage?.actionableMissingBaselines || 0} attention={Boolean(latestBaselineCoverage?.actionableMissingBaselines)} />
            <MiniStat label="Known broken missing" value={latestBaselineCoverage?.knownBrokenMissingBaselines || 0} attention={Boolean(latestBaselineCoverage?.knownBrokenMissingBaselines)} />
            <MiniStat label="Done this run" value={latestBaselinePace?.completedThisRun || 0} />
            <MiniStat
              label="Baseline rate"
              value={latestBaselinePace ? `${formatNumber(Math.round(latestBaselinePace.pagesPerHour))}/hr` : "Waiting"}
            />
            <MiniStat label="Estimated remaining" value={latestBaselinePace?.etaLabel || "Waiting"} />
          </div>
          {latestBaselineCoverage && (
            <ProgressBar
              className="mt-5"
              label="Screenshot baseline coverage"
              value={baselineCoveragePercent}
              detail={`${formatNumber(latestBaselineCoverage.existingBaselines)} baselined, ${formatNumber(latestBaselineCoverage.missingBaselines)} still missing${latestBaselinePace ? `; ${latestBaselinePace.completedThisRun} added in ${latestBaselinePace.elapsedLabel}` : ""}`}
            />
          )}
          <p className="mt-4 text-sm text-[var(--muted)]">
            Local baseline coverage tracks screenshots on this PC. R2 coverage tracks screenshots
            that are published for website viewing. Broken links are separated so they do not hide
            actionable missing screenshots.
          </p>
        </div>
      </section>

      <section className="mt-6">
        <RecentRuns runs={visualRuns.length ? visualRuns : workerRuns} title="Recent screenshot runs" />
      </section>

      <section className="mt-6">
        <RecentRuns runs={pageInfoRuns} title="Recent page information runs" />
      </section>

      <section className="mt-6">
        <RecentRuns runs={awardDetailRuns} title="Recent award detail runs" />
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
      <div className="flex items-center justify-between gap-3 text-sm font-bold text-[var(--muted)]">
        <span>{label}</span>
        <span>{value}%</span>
      </div>
      <div className="mt-2 h-3 overflow-hidden rounded-full bg-[var(--brand-blue-soft)]">
        <div className="h-full rounded-full bg-[var(--brand)]" style={{ width: `${value}%` }} />
      </div>
      <p className="mt-2 text-sm font-semibold text-[var(--muted)]">{detail}</p>
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

function RecentRuns({ runs, title }: { runs: LocalWorkerRun[]; title: string }) {
  return (
    <section className="card admin-section-card">
      <div className="flex items-center gap-2">
        <Clock3 size={18} aria-hidden="true" />
        <h2 className="text-2xl font-black">{title}</h2>
      </div>
      <div className="mt-5 grid gap-3">
        {runs.slice(0, 10).map((run) => {
          const metrics = workerRunMetrics(run);
          return (
            <div className="admin-run-row" key={run.id}>
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
                Checked {formatNumber(metrics.checked)}, {metrics.secondaryLabel}{" "}
                {formatNumber(metrics.secondaryValue)}, {metrics.tertiaryLabel}{" "}
                {formatNumber(metrics.tertiaryValue)}, failed {formatNumber(metrics.failed)}
              </p>
              {run.error && <p className="mt-2 text-sm font-semibold">{run.error}</p>}
            </div>
          );
        })}
        {runs.length === 0 && <p className="text-sm text-[var(--muted)]">No runs recorded.</p>}
      </div>
    </section>
  );
}

function workerRunMetrics(run: LocalWorkerRun) {
  const metadata = metadataObject(run.metadata);
  const counts = objectValue(metadata.counts);

  if (run.worker_name.includes("baseline-facts")) {
    const pipeline = effectiveDetailPipeline(metadata);
    const extraction = objectValue(pipeline.extraction);
    return {
      checked: numberFromObject(counts, "checked") || run.checked_count || 0,
      secondaryLabel: "extracted",
      secondaryValue: numberFromObject(extraction, "extracted") || run.initial_count || 0,
      tertiaryLabel: "applied",
      tertiaryValue:
        numberFromObject(extraction, "backfilled") ||
        numberFromObject(counts, "applied") ||
        run.changed_count ||
        0,
      failed: numberFromObject(extraction, "failed") || run.failed_count || 0,
    };
  }

  if (run.worker_name.includes("award-baseline-detail")) {
    const pipeline = effectiveDetailPipeline(metadata);
    const extraction = objectValue(pipeline.extraction);
    const publishing = objectValue(pipeline.publishing);
    return {
      checked:
        numberFromObject(extraction, "checked") ||
        numberFromObject(counts, "checked") ||
        run.checked_count ||
        0,
      secondaryLabel: "extracted",
      secondaryValue: numberFromObject(extraction, "extracted") || run.initial_count || 0,
      tertiaryLabel: "applied",
      tertiaryValue:
        numberFromObject(publishing, "applied") ||
        numberFromObject(counts, "applied") ||
        run.changed_count ||
        0,
      failed: numberFromObject(extraction, "failed") || run.failed_count || 0,
    };
  }

  const pipeline = objectValue(metadata.visual_pipeline);
  const capture = objectValue(pipeline.capture);
  const comparison = objectValue(pipeline.comparison);
  return {
    checked: numberFromObject(capture, "checked") || run.checked_count || 0,
    secondaryLabel: "baselined",
    secondaryValue: numberFromObject(capture, "baselined") || run.initial_count || 0,
    tertiaryLabel: "changed",
    tertiaryValue: numberFromObject(comparison, "true_changes") || run.changed_count || 0,
    failed: numberFromObject(capture, "failed") || run.failed_count || 0,
  };
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

function formatSafeModels(options: Record<string, unknown>) {
  const raw = options.gemini_cli_safe_models;
  if (Array.isArray(raw)) {
    const labels = raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return labels.length > 0 ? labels.join(", ") : "Not logged";
  }
  if (typeof raw === "string" && raw.trim()) return raw;
  return "Not logged";
}

function workerRunLabel(value: string) {
  return value
    .replace(/^local-/, "")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
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
