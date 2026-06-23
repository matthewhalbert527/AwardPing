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
    { count: sourceMetadataCount, error: sourceMetadataError },
    { count: visualSnapshotRecordCount, error: visualSnapshotRecordError },
  ] = await Promise.all([
    admin.from("local_worker_runs").select("*").order("started_at", { ascending: false }).limit(30),
    admin.from("shared_award_sources").select("*", { count: "exact", head: true }),
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
  const detailRuns = workerRuns.filter((run) => run.worker_name.includes("award-baseline-detail"));
  const latestVisualRun = visualRuns[0] || null;
  const latestDetailRun = detailRuns[0] || null;
  const latestVisualMetadata = latestVisualRun ? metadataObject(latestVisualRun.metadata) : {};
  const latestDetailMetadata = latestDetailRun ? metadataObject(latestDetailRun.metadata) : {};
  const latestCounts = objectValue(latestVisualMetadata.counts);
  const latestDetailCounts = objectValue(latestDetailMetadata.counts);
  const latestOptions = objectValue(latestVisualMetadata.options);
  const latestDetailOptions = objectValue(latestDetailMetadata.options);
  const latestPipeline = objectValue(latestVisualMetadata.visual_pipeline);
  const latestDetailPipeline = objectValue(latestDetailMetadata.detail_pipeline);
  const latestCapture = objectValue(latestPipeline.capture);
  const latestExtraction = objectValue(latestPipeline.extraction);
  const latestComparison = objectValue(latestPipeline.comparison);
  const latestPublishing = objectValue(latestPipeline.publishing);
  const latestDetailExtraction = objectValue(latestDetailPipeline.extraction);
  const latestDetailPublishing = objectValue(latestDetailPipeline.publishing);
  const latestGeminiCliUsage = objectValue(latestVisualMetadata.gemini_cli_usage);
  const latestDetailGeminiCliUsage = objectValue(latestDetailMetadata.gemini_cli_usage);
  const latestGeminiUsage = objectValue(latestVisualMetadata.gemini_usage);
  const latestBaselineCoverage = baselineCoverageFromMetadata(latestVisualMetadata);
  const baselineCoveragePercent = latestBaselineCoverage
    ? percent(latestBaselineCoverage.existingBaselines, latestBaselineCoverage.loadedSources)
    : 0;
  const latestVisualStage = visualRunStage(latestVisualRun, latestVisualMetadata);
  const renderedAt = new Date().toISOString();
  const pipelineErrors = [
    workerRunError?.message,
    sharedSourceError?.message,
    sourceMetadataError?.message,
    visualSnapshotRecordError?.message,
  ].filter(Boolean);
  const sourceMetadataPercent = percent(sourceMetadataCount || 0, sharedSourceCount || 0);

  return (
    <AdminShell>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="badge">Admin</span>
          <h1 className="mt-4 text-4xl font-black">Screenshot scans</h1>
          <p className="mt-2 max-w-3xl text-[var(--muted)]">
            Owner-only status for the daily local worker that captures screenshots, stores snapshots
            in R2, scans pages for award information, compares changes, and publishes meaningful updates.
          </p>
          <p className="mt-2 text-sm font-semibold text-[var(--muted)]">
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

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
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
          value={
            latestBaselineCoverage
              ? `${formatNumber(latestBaselineCoverage.existingBaselines)} / ${formatNumber(latestBaselineCoverage.loadedSources)}`
              : formatNumber(visualSnapshotRecordCount || 0)
          }
          detail={
            latestBaselineCoverage
              ? `${baselineCoveragePercent}% complete; ${formatNumber(latestBaselineCoverage.actionableMissingBaselines)} actionable missing`
              : `${formatNumber(visualSnapshotRecordCount || 0)} sources indexed in R2`
          }
        />
        <MetricCard
          icon={Sparkles}
          label="Gemini API calls"
          value={numberFromObject(latestGeminiUsage, "calls")}
          detail={`~$${formatUsd(numberFromObjectFloat(latestGeminiUsage, "estimated_cost_usd"))} estimated, cap ${formatApiCostCap(latestOptions)}`}
          attention={geminiApiCapReached(latestOptions, latestGeminiUsage)}
        />
        <MetricCard
          icon={Database}
          label="R2 uploads"
          value={numberFromObject(latestCounts, "r2_uploaded")}
          detail={`${formatNumber(numberFromObject(latestCounts, "r2_rotated"))} rotated, ${formatNumber(numberFromObject(latestCounts, "r2_failed"))} failed`}
          attention={numberFromObject(latestCounts, "r2_failed") > 0}
        />
        <MetricCard
          icon={Sparkles}
          label="Award details"
          value={latestDetailRun ? statusLabel(latestDetailRun.status) : "None"}
          detail={
            latestDetailRun
              ? `${formatNumber(numberFromObject(latestDetailExtraction, "extracted"))} extracted, ${formatNumber(numberFromObject(latestDetailPublishing, "applied"))} applied`
              : "No detail run logged"
          }
          attention={latestDetailRun?.status === "failed"}
        />
        <MetricCard
          icon={Activity}
          label="Published updates"
          value={numberFromObject(latestPublishing, "published_updates")}
          detail={`${formatNumber(numberFromObject(latestComparison, "true_changes"))} meaningful changes in latest run`}
          attention={numberFromObject(latestPublishing, "failed") > 0}
        />
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Eye size={18} aria-hidden="true" />
                <h2 className="text-2xl font-black">Daily screenshot pipeline</h2>
              </div>
              <p className="mt-2 text-sm text-[var(--muted)]">
                One local PC worker runs the full workflow. Gemini is only used for new baseline
                fact extraction and pages/PDFs that already look different.
              </p>
            </div>
            <StatusPill status={latestVisualRun?.status || "running"} />
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MiniStat label="Checked" value={numberFromObject(latestCapture, "checked") || latestVisualRun?.checked_count || 0} />
            <MiniStat label="Baselined" value={numberFromObject(latestCapture, "baselined") || latestVisualRun?.initial_count || 0} />
            <MiniStat label="Unchanged" value={numberFromObject(latestCapture, "unchanged") || latestVisualRun?.unchanged_count || 0} />
            <MiniStat label="Failed" value={numberFromObject(latestCapture, "failed") || latestVisualRun?.failed_count || 0} attention />
            <MiniStat label="Facts extracted" value={numberFromObject(latestExtraction, "extracted")} />
            <MiniStat label="Facts skipped" value={numberFromObject(latestExtraction, "skipped")} attention={geminiCapReached(latestOptions, latestGeminiCliUsage)} />
            <MiniStat label="Candidates" value={numberFromObject(latestComparison, "candidates")} />
            <MiniStat label="Interpreted" value={numberFromObject(latestComparison, "interpreted")} />
            <MiniStat label="Published" value={numberFromObject(latestPublishing, "published_updates")} />
            <MiniStat label="R2 uploaded" value={numberFromObject(latestCounts, "r2_uploaded")} />
            <MiniStat label="R2 failed" value={numberFromObject(latestCounts, "r2_failed")} attention={numberFromObject(latestCounts, "r2_failed") > 0} />
            <MiniStat label="Expanded controls" value={numberFromObject(latestCounts, "expanded_controls")} />
          </div>

          <div className="mt-5 grid gap-3">
            <PipelineRow
              icon={Eye}
              title="1. Capture screenshots and PDFs"
              detail={`Checked ${formatNumber(latestVisualRun?.checked_count || 0)}, baselined ${formatNumber(latestVisualRun?.initial_count || 0)}, failed ${formatNumber(latestVisualRun?.failed_count || 0)}.`}
              status={latestVisualRun ? statusLabel(latestVisualRun.status) : "Waiting"}
            />
            <PipelineRow
              icon={Sparkles}
              title="2. Scan pages for award information"
              detail={`Extracted ${formatNumber(numberFromObject(latestExtraction, "extracted"))}, backfilled ${formatNumber(numberFromObject(latestExtraction, "backfilled"))}, failed ${formatNumber(numberFromObject(latestExtraction, "failed"))}.`}
              status={
                geminiCapReached(latestOptions, latestGeminiCliUsage)
                  ? "Cap reached"
                  : booleanFromObject(latestExtraction, "enabled")
                    ? "On"
                    : "Off"
              }
              attention={numberFromObject(latestExtraction, "failed") > 0 || geminiCapReached(latestOptions, latestGeminiCliUsage)}
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
            <div className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4">
              <h3 className="font-black">R2 snapshot storage</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <MiniStat label="Uploaded objects" value={numberFromObject(latestCounts, "r2_uploaded")} />
                <MiniStat label="Rotated objects" value={numberFromObject(latestCounts, "r2_rotated")} />
                <MiniStat label="Upload failures" value={numberFromObject(latestCounts, "r2_failed")} attention={numberFromObject(latestCounts, "r2_failed") > 0} />
                <MiniStat label="Skipped existing" value={numberFromObject(latestCounts, "r2_skipped_existing")} />
              </div>
              <dl className="mt-3 grid gap-3 text-sm text-[var(--muted)] sm:grid-cols-2">
                <Detail label="R2 sync" value={booleanFromObject(latestOptions, "r2_snapshot_sync") ? "On" : "Off"} />
                <Detail label="Bucket" value={stringFromObject(latestOptions, "r2_bucket") || "Not set"} />
              </dl>
            </div>

            <div className="rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4">
              <h3 className="font-black">Page information scan</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <MiniStat label="Extracted" value={numberFromObject(latestExtraction, "extracted")} />
                <MiniStat label="Skipped" value={numberFromObject(latestExtraction, "skipped")} attention={geminiApiCapReached(latestOptions, latestGeminiUsage) || geminiCapReached(latestOptions, latestGeminiCliUsage)} />
                <MiniStat label="Failed" value={numberFromObject(latestExtraction, "failed")} attention={numberFromObject(latestExtraction, "failed") > 0} />
                <MiniStat label="Backfilled" value={numberFromObject(latestExtraction, "backfilled")} />
              </div>
              <dl className="mt-3 grid gap-3 text-sm text-[var(--muted)] sm:grid-cols-2">
                <Detail label="Provider" value={latestVisualRun?.ai_provider || stringFromObject(latestExtraction, "provider") || "None"} />
                <Detail label="Model" value={stringFromObject(latestExtraction, "model") || stringFromObject(latestVisualMetadata, "ai_model") || "None"} />
                <Detail label="API calls" value={formatNumber(numberFromObject(latestGeminiUsage, "calls"))} />
                <Detail label="Estimated API cost" value={`$${formatUsd(numberFromObjectFloat(latestGeminiUsage, "estimated_cost_usd"))}`} />
                <Detail label="API cost cap" value={formatApiCostCap(latestOptions)} />
                <Detail label="CLI call cap" value={formatCap(latestOptions)} />
              </dl>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4">
            <h3 className="font-black">Screenshot behavior checks</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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

          <div className="mt-5 rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4">
            <h3 className="font-black">Latest run detail</h3>
            {latestVisualRun ? (
              <dl className="mt-3 grid gap-3 text-sm text-[var(--muted)] sm:grid-cols-2">
                <Detail label="Started" value={formatDate(latestVisualRun.started_at)} />
                <Detail label="Finished" value={latestVisualRun.finished_at ? formatDate(latestVisualRun.finished_at) : "Still running"} />
                <Detail label="AI provider" value={latestVisualRun.ai_provider || "none"} />
                <Detail label="AI model" value={stringFromObject(latestVisualMetadata, "ai_model") || "none"} />
                <Detail label="Current stage" value={latestVisualStage} />
                <Detail label="Archive root" value={stringFromObject(latestVisualMetadata, "archive_root") || "Local worker default"} />
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

          <div className="mt-5 rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4">
            <h3 className="font-black">Baseline award details</h3>
            {latestDetailRun ? (
              <>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <MiniStat label="Awards checked" value={latestDetailRun.checked_count || 0} />
                  <MiniStat label="Skipped existing" value={numberFromObject(latestDetailCounts, "skipped_existing")} />
                  <MiniStat label="Details extracted" value={numberFromObject(latestDetailExtraction, "extracted")} />
                  <MiniStat label="Website summaries applied" value={numberFromObject(latestDetailPublishing, "applied")} />
                  <MiniStat
                    label="No baseline yet"
                    value={numberFromObject(latestDetailExtraction, "no_baseline")}
                    attention={numberFromObject(latestDetailExtraction, "no_baseline") > 0}
                  />
                </div>
                <dl className="mt-3 grid gap-3 text-sm text-[var(--muted)] sm:grid-cols-2">
                  <Detail label="Started" value={formatDate(latestDetailRun.started_at)} />
                  <Detail label="Finished" value={latestDetailRun.finished_at ? formatDate(latestDetailRun.finished_at) : "Still running"} />
                  <Detail label="AI model" value={stringFromObject(latestDetailMetadata, "ai_model") || "Gemini CLI"} />
                  <Detail label="Gemini CLI calls" value={formatNumber(numberFromObject(latestDetailGeminiCliUsage, "calls"))} />
                  <Detail label="Call cap" value={formatCap(latestDetailOptions)} />
                  <Detail label="Safe models" value={formatSafeModels(latestDetailOptions)} />
                  <Detail label="Unsafe override" value={booleanFromObject(latestDetailOptions, "allow_unsafe_gemini_cli_model") ? "On" : "Off"} />
                </dl>
              </>
            ) : (
              <p className="mt-3 text-sm text-[var(--muted)]">
                No baseline award-detail run has been recorded yet.
              </p>
            )}
          </div>
        </div>

        <div className="card p-6">
          <div className="flex items-center gap-2">
            <Database size={18} aria-hidden="true" />
            <h2 className="text-2xl font-black">Snapshot coverage</h2>
          </div>
          <div className="mt-5 grid gap-3">
            <MiniStat label="Catalog source pages" value={sharedSourceCount || 0} />
            <MiniStat label="Page outlines scanned" value={`${formatNumber(sourceMetadataCount || 0)} (${sourceMetadataPercent}%)`} />
            <MiniStat label="R2 snapshot rows" value={visualSnapshotRecordCount || 0} />
            <MiniStat label="Actionable missing" value={latestBaselineCoverage?.actionableMissingBaselines || 0} attention={Boolean(latestBaselineCoverage?.actionableMissingBaselines)} />
            <MiniStat label="Known broken missing" value={latestBaselineCoverage?.knownBrokenMissingBaselines || 0} attention={Boolean(latestBaselineCoverage?.knownBrokenMissingBaselines)} />
          </div>
          {latestBaselineCoverage && (
            <ProgressBar
              className="mt-5"
              label="Screenshot baseline coverage"
              value={baselineCoveragePercent}
              detail={`${formatNumber(latestBaselineCoverage.existingBaselines)} baselined, ${formatNumber(latestBaselineCoverage.missingBaselines)} still missing`}
            />
          )}
          <p className="mt-4 text-sm text-[var(--muted)]">
            This baseline number is based on the local screenshot archive, not the retired text
            checker. Broken links are separated so they do not hide actionable missing screenshots.
          </p>
        </div>
      </section>

      <section className="mt-6">
        <RecentRuns runs={visualRuns.length ? visualRuns : workerRuns} title="Recent screenshot runs" />
      </section>

      <section className="mt-6">
        <RecentRuns runs={detailRuns} title="Recent award detail runs" />
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
    <div className={`rounded-2xl border border-[var(--line)] bg-[#f5f7ff] p-4 ${attention ? "border-[var(--brand-pink)]" : ""}`}>
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
    <div className="min-w-0">
      <dt className="text-xs font-black uppercase">{label}</dt>
      <dd className="mt-1 break-words font-semibold text-[var(--foreground)]">{value}</dd>
    </div>
  );
}

function RecentRuns({ runs, title }: { runs: LocalWorkerRun[]; title: string }) {
  return (
    <section className="card p-6">
      <div className="flex items-center gap-2">
        <Clock3 size={18} aria-hidden="true" />
        <h2 className="text-2xl font-black">{title}</h2>
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
        {runs.length === 0 && <p className="text-sm text-[var(--muted)]">No runs recorded.</p>}
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
