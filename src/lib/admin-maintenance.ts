import "server-only";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_BASELINE_COST_CAP_USD,
  type MaintenanceProfileId,
} from "@/lib/maintenance-profiles";
import type { Database } from "@/lib/database.types";
import {
  sourceQualityDecision,
  type SourceQualitySource,
} from "@/lib/source-quality";

type AdminClient = SupabaseClient<Database>;
type LocalWorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

const visualReviewStatuses = [
  "pending",
  "submitted",
  "processing",
  "succeeded",
  "rejected",
  "failed",
  "published",
  "superseded",
] as const;

type VisualReviewStatus = (typeof visualReviewStatuses)[number];

export type ReasonCount = {
  reason: string;
  count: number;
};

export type LatestWorkerReportMetadata = {
  latestRun: LocalWorkerRun | null;
  latestMaintenanceRun: LocalWorkerRun | null;
  latestVisualRun: LocalWorkerRun | null;
  latestSourceQualityRun: LocalWorkerRun | null;
  latestVisualReviewRun: LocalWorkerRun | null;
  latestMetadata: Record<string, unknown>;
  latestMaintenanceMetadata: Record<string, unknown>;
  latestVisualMetadata: Record<string, unknown>;
  latestSourceQualityMetadata: Record<string, unknown>;
  latestVisualReviewMetadata: Record<string, unknown>;
};

export type SourceQualitySummary = {
  openSources: number;
  monitorEligibleSources: number;
  publicEligibleSources: number;
  factEligibleSources: number;
  openRejectedSources: number;
  reviewLaterSources: number;
  skippedManualProtected: number;
  rejectedByReason: ReasonCount[];
  latestCleanupRun: {
    label: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    apply: boolean | null;
    candidatesFound: number | null;
    movedToReviewLater: number | null;
    skippedManualProtected: number | null;
    rejectedByReason: ReasonCount[];
  } | null;
};

export type DiscoverySummary = {
  discoveryMode: boolean | null;
  discoveryCandidates: number;
  discoveryRejectedByQuality: number;
  discoveryInsertedPending: number;
  discoveryInsertedOpen: number;
  discoveryRejectedByIdentity: number;
  discoverySkippedExisting: number;
  capHitsByAward: ReasonCount[];
  capHitsByDomain: ReasonCount[];
  capHitsBySource: ReasonCount[];
  standardCaptureCreatedSources: boolean;
};

export type VisualReviewBatchSummary = {
  configured: boolean;
  warning: string | null;
  statusCounts: Record<VisualReviewStatus, number>;
  latestBatchName: string | null;
  model: string | null;
  requestCount: number;
  submittedAt: string | null;
  completedAt: string | null;
  estimatedCostUsd: number;
  actualUsage: Record<string, unknown>;
  actualCostUsd: number | null;
};

export type PreAiGateSummary = {
  candidateChanges: number;
  deterministicSourceRejected: number;
  deterministicNoiseRejected: number;
  textOnlyCandidates: number;
  textOnlyNoiseRejected: number;
  textOnlyPublishedOrQueued: number;
  visualOnlyCandidateEnqueued: number;
  aiReviewed: number;
  aiRejected: number;
  trueChangesPublished: number;
  trueChangeRate: number;
};

export type TextOnlyChangeSummary = {
  textOnlyCandidates: number;
  textOnlyNoiseRejected: number;
  textOnlyPublishedOrQueued: number;
  textOnlyIgnored: number;
  needsAttention: boolean;
};

export type SuppressionSummary = {
  configured: boolean;
  warning: string | null;
  suppressedChangeEvents: number;
  suppressionReasons: ReasonCount[];
  latestSuppressedEvents: Array<{
    id: string;
    sourceTitle: string | null;
    sourceUrl: string | null;
    summary: string;
    reason: string | null;
    suppressedAt: string | null;
  }>;
};

export type CaptureProfileSummary = {
  captureProfile: string | null;
  expansionScreenshotsTaken: number;
  r2UploadsSkippedUnchanged: number;
  r2UploadsSkippedNoise: number;
  mainContentHashChanged: number;
  chromeOnlyHashChanged: number;
  pageReadyWaitMs: number;
  captureSettleWaitMs: number;
  scrollActivationWaitMs: number;
};

export type AiModeSummary = {
  aiRequired: boolean | null;
  aiProvider: string | null;
  aiDisabledReason: string | null;
  visualReviewMode: string | null;
  geminiApiPricingMode: string | null;
  synchronousBatchPricingWarning: boolean;
};

export type MaintenanceRunnerState = {
  workerAppDir: string;
  runnerPath: string;
  runnerExists: boolean;
  controlAvailable: boolean;
  unavailableReason: string;
  hostedRuntime: boolean;
};

export type MaintenanceCommandOptions = {
  apply?: boolean;
  baselineCostCapUsd?: number;
};

export type MaintenanceReportPhase = {
  name?: string;
  status?: string;
  started_at?: string;
  finished_at?: string | null;
  exit_code?: number | null;
  log_path?: string;
};

export type MaintenanceReport = {
  path: string;
  started_at?: string;
  finished_at?: string | null;
  status?: string;
  profile?: string;
  apply?: boolean;
  phases?: MaintenanceReportPhase[];
};

const runnerFile = "run-awardping-maintenance.mjs";

export function getMaintenanceRunnerState(): MaintenanceRunnerState {
  const explicitAppDir = cleanText(
    process.env.AWARDPING_WORKER_APP_DIR || process.env.AWARDPING_MAINTENANCE_APP_DIR,
  );
  const defaultWorkerAppDir = defaultLocalWorkerAppDir();
  const workerAppDir = explicitAppDir || defaultWorkerAppDir;
  const runnerPath =
    cleanText(process.env.AWARDPING_MAINTENANCE_RUNNER) ||
    (workerAppDir ? join(workerAppDir, "scripts", runnerFile) : "");

  const runnerExists = existsSync(runnerPath);
  const hostedRuntime = isHostedRuntime();
  const disabled = process.env.AWARDPING_ADMIN_DISABLE_LOCAL_MAINTENANCE === "1";
  const controlAvailable = runnerExists && !hostedRuntime && !disabled;
  const unavailableReason = controlAvailable
    ? ""
    : hostedRuntime
      ? "Direct worker control is unavailable from the hosted deployment."
      : disabled
        ? "Direct worker control is disabled by AWARDPING_ADMIN_DISABLE_LOCAL_MAINTENANCE."
        : "The local maintenance runner was not found on this server.";

  return {
    workerAppDir: workerAppDir ? resolve(workerAppDir) : "",
    runnerPath: runnerPath ? resolve(runnerPath) : "",
    runnerExists,
    controlAvailable,
    unavailableReason,
    hostedRuntime,
  };
}

export function maintenanceRunnerArgs(
  profile: MaintenanceProfileId,
  options: MaintenanceCommandOptions,
  state = getMaintenanceRunnerState(),
) {
  const apply = options.apply ?? true;
  const baselineCostCapUsd = safeCostCap(options.baselineCostCapUsd);
  const scriptPath =
    state.runnerPath ||
    (state.workerAppDir ? join(state.workerAppDir, "scripts", runnerFile) : `scripts/${runnerFile}`);
  return [
    scriptPath,
    ...maintenanceEnvArgs(state.workerAppDir),
    `--profile=${profile}`,
    `--apply=${apply}`,
    `--baseline-cost-cap-usd=${baselineCostCapUsd}`,
  ];
}

export function maintenanceCommandForDisplay(
  profile: MaintenanceProfileId,
  options: MaintenanceCommandOptions,
  state = getMaintenanceRunnerState(),
) {
  return formatCommand([process.execPath, ...maintenanceRunnerArgs(profile, options, state)]);
}

export function readLatestMaintenanceReport(
  state = getMaintenanceRunnerState(),
): MaintenanceReport | null {
  if (!state.workerAppDir) return null;
  const reportsDir = join(state.workerAppDir, "reports");
  if (!existsSync(reportsDir)) return null;

  const candidates = readdirSync(reportsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("maintenance-"))
    .map((entry) => join(reportsDir, entry.name, "summary.json"))
    .filter((path) => existsSync(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  const path = candidates[0];
  if (!path) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      path,
      started_at: cleanText(parsed.started_at),
      finished_at:
        typeof parsed.finished_at === "string" ? parsed.finished_at : parsed.finished_at === null ? null : undefined,
      status: cleanText(parsed.status),
      profile: cleanText(parsed.profile),
      apply: typeof parsed.apply === "boolean" ? parsed.apply : undefined,
      phases: Array.isArray(parsed.phases)
        ? parsed.phases
            .map((phase) => maintenanceReportPhase(phase))
            .filter((phase): phase is MaintenanceReportPhase => Boolean(phase))
        : [],
    };
  } catch {
    return null;
  }
}

export function parseLatestWorkerReportMetadata(runs: LocalWorkerRun[]): LatestWorkerReportMetadata {
  const latestRun = runs[0] || null;
  const latestMaintenanceRun = runs.find((run) => {
    const metadata = objectValue(run.metadata);
    return run.worker_name === "local-maintenance-runner" || metadata.kind === "maintenance";
  }) || null;
  const latestVisualRun = runs.find((run) => {
    const metadata = objectValue(run.metadata);
    return metadata.kind === "visual_snapshot" || run.worker_name.includes("visual-snapshot");
  }) || null;
  const latestSourceQualityRun = runs.find((run) => {
    const metadata = objectValue(run.metadata);
    if (metadata.kind === "source_quality" || metadata.kind === "source-quality") return true;
    if (run.worker_name.includes("source-quality")) return true;
    return maintenancePhases(metadata).some((phase) => phase.name === "source-quality");
  }) || null;
  const latestVisualReviewRun = runs.find((run) => {
    const metadata = objectValue(run.metadata);
    if (metadata.kind === "visual_review_batch" || metadata.kind === "visual-review-batch") return true;
    if (run.worker_name.includes("visual-review")) return true;
    return maintenancePhases(metadata).some((phase) => phase.name === "visual-review-batch");
  }) || null;

  return {
    latestRun,
    latestMaintenanceRun,
    latestVisualRun,
    latestSourceQualityRun,
    latestVisualReviewRun,
    latestMetadata: objectValue(latestRun?.metadata),
    latestMaintenanceMetadata: objectValue(latestMaintenanceRun?.metadata),
    latestVisualMetadata: objectValue(latestVisualRun?.metadata),
    latestSourceQualityMetadata: objectValue(latestSourceQualityRun?.metadata),
    latestVisualReviewMetadata: objectValue(latestVisualReviewRun?.metadata),
  };
}

export async function loadSourceQualityAdminSummary(
  admin: AdminClient,
  runs: LocalWorkerRun[] = [],
): Promise<{ summary: SourceQualitySummary; loadErrors: string[] }> {
  const loadErrors: string[] = [];
  const [openSources, reviewLaterSources] = await Promise.all([
    loadActiveSourcesForQuality(admin, "open", loadErrors),
    countSourcesByReviewStatus(admin, "review_later", loadErrors),
  ]);
  return {
    summary: summarizeSourceQuality(
      openSources,
      reviewLaterSources,
      parseLatestWorkerReportMetadata(runs),
    ),
    loadErrors,
  };
}

export function summarizeSourceQuality(
  openSources: SourceQualitySource[],
  reviewLaterSources = 0,
  reportMetadata: LatestWorkerReportMetadata = parseLatestWorkerReportMetadata([]),
): SourceQualitySummary {
  const rejectedByReason = new Map<string, number>();
  let monitorEligibleSources = 0;
  let publicEligibleSources = 0;
  let factEligibleSources = 0;
  let skippedManualProtected = 0;

  for (const source of openSources) {
    const monitoring = sourceQualityDecision(source, { purpose: "monitoring" });
    const publicDecision = sourceQualityDecision(source, { purpose: "public" });
    const factDecision = sourceQualityDecision(source, { purpose: "facts" });
    if (monitoring.allowed) monitorEligibleSources += 1;
    else incrementMap(rejectedByReason, monitoring.reason);
    if (publicDecision.allowed) publicEligibleSources += 1;
    if (factDecision.allowed) factEligibleSources += 1;
    if (monitoring.allowed && !factDecision.allowed && factDecision.reason === "missing_baseline_facts") {
      skippedManualProtected += 1;
    }
  }

  return {
    openSources: openSources.length,
    monitorEligibleSources,
    publicEligibleSources,
    factEligibleSources,
    openRejectedSources: Math.max(0, openSources.length - monitorEligibleSources),
    reviewLaterSources,
    skippedManualProtected,
    rejectedByReason: reasonCountsFromMap(rejectedByReason),
    latestCleanupRun: latestSourceQualityCleanupRun(reportMetadata),
  };
}

export function summarizeDiscovery(metadata: Record<string, unknown>): DiscoverySummary {
  const counts = metadataCounts(metadata);
  const pipelineDiscovery = objectValue(objectValue(metadata.visual_pipeline).discovery);
  const options = objectValue(metadata.options);
  const discoveryModeValue =
    boolValue(counts.discovery_mode) ??
    boolValue(pipelineDiscovery.enabled) ??
    boolValue(options.discovery_mode);
  const insertedPending = numberFromPaths(metadata, [
    ["counts", "discovery_inserted_pending"],
    ["visual_pipeline", "discovery", "inserted_pending"],
  ]);
  const insertedOpen = numberFromPaths(metadata, [
    ["counts", "discovery_inserted_open"],
    ["visual_pipeline", "discovery", "inserted_open"],
  ]);
  const discoveredPdfSources = numberFromPaths(metadata, [["counts", "discovered_pdf_sources"]]);
  const discoveredHtmlSources = numberFromPaths(metadata, [["counts", "discovered_html_sources"]]);

  return {
    discoveryMode: discoveryModeValue,
    discoveryCandidates: numberFromPaths(metadata, [
      ["counts", "discovery_candidates"],
      ["visual_pipeline", "discovery", "candidates"],
    ]),
    discoveryRejectedByQuality: numberFromPaths(metadata, [
      ["counts", "discovery_rejected_by_quality"],
      ["visual_pipeline", "discovery", "rejected_by_quality"],
    ]),
    discoveryInsertedPending: insertedPending,
    discoveryInsertedOpen: insertedOpen,
    discoveryRejectedByIdentity: numberFromPaths(metadata, [
      ["counts", "discovery_rejected_by_identity"],
      ["visual_pipeline", "discovery", "rejected_by_identity"],
    ]),
    discoverySkippedExisting: numberFromPaths(metadata, [
      ["counts", "discovery_skipped_existing"],
      ["visual_pipeline", "discovery", "skipped_existing"],
    ]),
    capHitsByAward: reasonCounts(objectValue(
      pipelineDiscovery.cap_hits_by_award || counts.discovery_cap_hits_by_award,
    )),
    capHitsByDomain: reasonCounts(objectValue(
      pipelineDiscovery.cap_hits_by_domain || counts.discovery_cap_hits_by_domain,
    )),
    capHitsBySource: reasonCounts(objectValue(
      pipelineDiscovery.cap_hits_by_source || counts.discovery_cap_hits_by_source,
    )),
    standardCaptureCreatedSources: discoveryModeValue === false && (
      insertedPending + insertedOpen + discoveredPdfSources + discoveredHtmlSources
    ) > 0,
  };
}

export async function loadVisualReviewBatchSummary(
  admin: AdminClient,
): Promise<{ summary: VisualReviewBatchSummary; loadErrors: string[] }> {
  const rawAdmin = admin as unknown as SupabaseClient;
  const statusCounts: Record<VisualReviewStatus, number> = emptyVisualReviewStatusCounts();
  const countResults = await Promise.all(
    visualReviewStatuses.map(async (status) => {
      const result = await rawAdmin
        .from("shared_award_visual_review_candidates")
        .select("id", { count: "exact", head: true })
        .eq("status", status);
      return { queueStatus: status, count: result.count, error: result.error };
    }),
  );
  const missingError = countResults.find((result) => result.error && isMissingRelationError(result.error.message));
  if (missingError) {
    const warning = "Visual review queue not configured.";
    return { summary: visualReviewBatchUnavailable(warning), loadErrors: [warning] };
  }

  const loadErrors = countResults
    .map((result) => result.error?.message)
    .filter((message): message is string => Boolean(message));
  for (const result of countResults) {
    statusCounts[result.queueStatus] = result.count || 0;
  }

  const latestResult = await rawAdmin
    .from("shared_award_visual_review_candidates")
    .select("gemini_batch_name, model, submitted_at, completed_at, estimated_cost_usd, actual_usage")
    .not("gemini_batch_name", "is", null)
    .order("submitted_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (latestResult.error?.message) loadErrors.push(latestResult.error.message);
  const latest = objectValue(latestResult.data);
  const batchName = cleanText(latest.gemini_batch_name) || null;
  let requestCount = 0;
  if (batchName) {
    const requestCountResult = await rawAdmin
      .from("shared_award_visual_review_candidates")
      .select("id", { count: "exact", head: true })
      .eq("gemini_batch_name", batchName);
    if (requestCountResult.error?.message) loadErrors.push(requestCountResult.error.message);
    requestCount = requestCountResult.count || 0;
  }

  const actualUsage = objectValue(latest.actual_usage);
  return {
    summary: {
      configured: true,
      warning: null,
      statusCounts,
      latestBatchName: batchName,
      model: cleanText(latest.model) || null,
      requestCount,
      submittedAt: cleanText(latest.submitted_at) || null,
      completedAt: cleanText(latest.completed_at) || null,
      estimatedCostUsd: numberValue(latest.estimated_cost_usd),
      actualUsage,
      actualCostUsd: nullableNumber(actualUsage.estimated_cost_usd ?? actualUsage.actual_cost_usd),
    },
    loadErrors,
  };
}

export function summarizeVisualReviewBatch(
  rows: Array<Record<string, unknown>>,
  warning: string | null = null,
): VisualReviewBatchSummary {
  if (warning) return visualReviewBatchUnavailable(warning);
  const statusCounts = emptyVisualReviewStatusCounts();
  for (const row of rows) {
    const status = cleanStatus(row.status);
    if (status) statusCounts[status] += 1;
  }
  const latest = [...rows]
    .filter((row) => cleanText(row.gemini_batch_name))
    .sort((left, right) => dateMs(cleanText(right.submitted_at)) - dateMs(cleanText(left.submitted_at)))[0] || {};
  const batchName = cleanText(latest.gemini_batch_name) || null;
  const actualUsage = objectValue(latest.actual_usage);
  return {
    configured: true,
    warning: null,
    statusCounts,
    latestBatchName: batchName,
    model: cleanText(latest.model) || null,
    requestCount: batchName ? rows.filter((row) => row.gemini_batch_name === batchName).length : 0,
    submittedAt: cleanText(latest.submitted_at) || null,
    completedAt: cleanText(latest.completed_at) || null,
    estimatedCostUsd: rows
      .filter((row) => !batchName || row.gemini_batch_name === batchName)
      .reduce((total, row) => total + numberValue(row.estimated_cost_usd), 0),
    actualUsage,
    actualCostUsd: nullableNumber(actualUsage.estimated_cost_usd ?? actualUsage.actual_cost_usd),
  };
}

export function summarizePreAiGate(metadata: Record<string, unknown>): PreAiGateSummary {
  const candidateChanges = numberFromPaths(metadata, [
    ["counts", "candidate_changes"],
    ["visual_pipeline", "comparison", "candidates"],
  ]);
  const aiReviewed = numberFromPaths(metadata, [
    ["counts", "visual_interpreted"],
    ["visual_pipeline", "comparison", "interpreted"],
    ["counts", "review"],
    ["visual_pipeline", "comparison", "review"],
  ]);
  const trueChangesPublished = numberFromPaths(metadata, [
    ["counts", "published_updates"],
    ["visual_pipeline", "publishing", "published_updates"],
    ["counts", "ai_true_changes"],
    ["visual_pipeline", "comparison", "true_changes"],
  ]);
  return {
    candidateChanges,
    deterministicSourceRejected: numberFromPaths(metadata, [
      ["counts", "deterministic_source_rejected"],
      ["visual_pipeline", "comparison", "deterministic_source_rejected"],
    ]),
    deterministicNoiseRejected: numberFromPaths(metadata, [
      ["counts", "deterministic_noise_rejected"],
      ["visual_pipeline", "comparison", "deterministic_noise_rejected"],
    ]),
    textOnlyCandidates: numberFromPaths(metadata, [
      ["counts", "text_only_candidates"],
      ["visual_pipeline", "comparison", "text_only_candidates"],
    ]),
    textOnlyNoiseRejected: numberFromPaths(metadata, [
      ["counts", "text_only_noise_rejected"],
      ["visual_pipeline", "comparison", "text_only_noise_rejected"],
    ]),
    textOnlyPublishedOrQueued: numberFromPaths(metadata, [
      ["counts", "text_only_published_or_queued"],
      ["visual_pipeline", "comparison", "text_only_published_or_queued"],
    ]),
    visualOnlyCandidateEnqueued: numberFromPaths(metadata, [
      ["counts", "visual_only_candidate_enqueued"],
      ["visual_pipeline", "comparison", "visual_only_candidate_enqueued"],
    ]),
    aiReviewed,
    aiRejected: numberFromPaths(metadata, [
      ["counts", "ai_rejected"],
      ["visual_pipeline", "comparison", "rejected"],
    ]),
    trueChangesPublished,
    trueChangeRate: percentNumber(trueChangesPublished, Math.max(aiReviewed, candidateChanges)),
  };
}

export function summarizeTextOnlyChanges(metadata: Record<string, unknown>): TextOnlyChangeSummary {
  const summary = {
    textOnlyCandidates: numberFromPaths(metadata, [
      ["counts", "text_only_candidates"],
      ["visual_pipeline", "comparison", "text_only_candidates"],
    ]),
    textOnlyNoiseRejected: numberFromPaths(metadata, [
      ["counts", "text_only_noise_rejected"],
      ["visual_pipeline", "comparison", "text_only_noise_rejected"],
    ]),
    textOnlyPublishedOrQueued: numberFromPaths(metadata, [
      ["counts", "text_only_published_or_queued"],
      ["visual_pipeline", "comparison", "text_only_published_or_queued"],
    ]),
    textOnlyIgnored: numberFromPaths(metadata, [["counts", "text_only_ignored"]]),
    needsAttention: false,
  };
  summary.needsAttention = summary.textOnlyIgnored > 0;
  return summary;
}

export async function loadSuppressionSummary(
  admin: AdminClient,
): Promise<{ summary: SuppressionSummary; loadErrors: string[] }> {
  const countResult = await admin
    .from("shared_award_change_events")
    .select("id", { count: "exact", head: true })
    .not("suppressed_at", "is", null);
  if (countResult.error && isMissingRelationError(countResult.error.message)) {
    const warning = "Change-event suppression columns are not configured.";
    return { summary: suppressionUnavailable(warning), loadErrors: [warning] };
  }

  const loadErrors = countResult.error?.message ? [countResult.error.message] : [];
  const latestResult = await admin
    .from("shared_award_change_events")
    .select("id, source_title, source_url, summary, suppression_reason, suppressed_at")
    .not("suppressed_at", "is", null)
    .order("suppressed_at", { ascending: false, nullsFirst: false })
    .limit(20);
  if (latestResult.error?.message) loadErrors.push(latestResult.error.message);

  const reasonResult = await admin
    .from("shared_award_change_events")
    .select("suppression_reason")
    .not("suppressed_at", "is", null)
    .limit(5000);
  if (reasonResult.error?.message) loadErrors.push(reasonResult.error.message);

  const reasonMap = new Map<string, number>();
  for (const row of reasonResult.data || []) {
    incrementMap(reasonMap, cleanText(row.suppression_reason) || "suppressed");
  }

  return {
    summary: {
      configured: true,
      warning: null,
      suppressedChangeEvents: countResult.count || 0,
      suppressionReasons: reasonCountsFromMap(reasonMap),
      latestSuppressedEvents: (latestResult.data || []).map((row) => ({
        id: row.id,
        sourceTitle: row.source_title,
        sourceUrl: row.source_url,
        summary: row.summary,
        reason: row.suppression_reason,
        suppressedAt: row.suppressed_at,
      })),
    },
    loadErrors,
  };
}

export function summarizeSuppression(rows: Array<Record<string, unknown>>, warning: string | null = null): SuppressionSummary {
  if (warning) return suppressionUnavailable(warning);
  const reasonMap = new Map<string, number>();
  for (const row of rows) incrementMap(reasonMap, cleanText(row.suppression_reason) || "suppressed");
  return {
    configured: true,
    warning: null,
    suppressedChangeEvents: rows.length,
    suppressionReasons: reasonCountsFromMap(reasonMap),
    latestSuppressedEvents: rows.slice(0, 20).map((row) => ({
      id: cleanText(row.id),
      sourceTitle: cleanText(row.source_title) || null,
      sourceUrl: cleanText(row.source_url) || null,
      summary: cleanText(row.summary),
      reason: cleanText(row.suppression_reason) || null,
      suppressedAt: cleanText(row.suppressed_at) || null,
    })),
  };
}

export function summarizeCaptureProfile(metadata: Record<string, unknown>): CaptureProfileSummary {
  return {
    captureProfile: cleanText(getPath(metadata, ["counts", "capture_profile"]) || getPath(metadata, ["options", "capture_profile"])) || null,
    expansionScreenshotsTaken: numberFromPaths(metadata, [["counts", "expansion_screenshots_taken"]]),
    r2UploadsSkippedUnchanged: numberFromPaths(metadata, [["counts", "r2_uploads_skipped_unchanged"]]),
    r2UploadsSkippedNoise: numberFromPaths(metadata, [["counts", "r2_uploads_skipped_noise"]]),
    mainContentHashChanged: numberFromPaths(metadata, [["counts", "main_content_hash_changed"]]),
    chromeOnlyHashChanged: numberFromPaths(metadata, [["counts", "chrome_only_hash_changed"]]),
    pageReadyWaitMs: numberFromPaths(metadata, [["counts", "page_ready_wait_ms"]]),
    captureSettleWaitMs: numberFromPaths(metadata, [["counts", "capture_settle_wait_ms"]]),
    scrollActivationWaitMs: numberFromPaths(metadata, [["counts", "scroll_activation_wait_ms"]]),
  };
}

export function summarizeAiMode(metadata: Record<string, unknown>): AiModeSummary {
  const counts = metadataCounts(metadata);
  const options = objectValue(metadata.options);
  const geminiUsage = objectValue(metadata.gemini_usage);
  const visualReviewMode = cleanText(counts.visual_review_mode || options.visual_review_mode);
  const geminiApiPricingMode = cleanText(geminiUsage.pricing_mode || options.gemini_api_pricing_mode);
  const geminiCalls = numberValue(geminiUsage.calls);
  return {
    aiRequired: boolValue(metadata.ai_required),
    aiProvider: cleanText(metadata.ai_provider) || null,
    aiDisabledReason: cleanText(metadata.ai_disabled_reason) || null,
    visualReviewMode: visualReviewMode || null,
    geminiApiPricingMode: geminiApiPricingMode || null,
    synchronousBatchPricingWarning: geminiApiPricingMode === "batch" && visualReviewMode === "immediate" && geminiCalls > 0,
  };
}

async function loadActiveSourcesForQuality(
  admin: AdminClient,
  status: "open" | "review_later",
  loadErrors: string[],
) {
  const sources: SourceQualitySource[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("shared_award_sources")
      .select(
        "url, title, display_title, page_description, page_metadata, page_metadata_generated_at, page_type, source, reason, submitted_by_user_id, shared_awards!inner(status)",
      )
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", status)
      .range(from, from + 999);

    if (error) {
      loadErrors.push(error.message);
      break;
    }

    const rows = (data || []) as unknown as SourceQualitySource[];
    sources.push(...rows);
    if (rows.length < 1000) break;
  }
  return sources;
}

async function countSourcesByReviewStatus(
  admin: AdminClient,
  status: "open" | "review_later",
  loadErrors: string[],
) {
  const { count, error } = await admin
    .from("shared_award_sources")
    .select("id, shared_awards!inner(status)", { count: "exact", head: true })
    .eq("shared_awards.status", "active")
    .eq("admin_review_status", status);
  if (error?.message) loadErrors.push(error.message);
  return count || 0;
}

function latestSourceQualityCleanupRun(
  reportMetadata: LatestWorkerReportMetadata,
): SourceQualitySummary["latestCleanupRun"] {
  const run = reportMetadata.latestSourceQualityRun || reportMetadata.latestMaintenanceRun;
  const metadata =
    Object.keys(reportMetadata.latestSourceQualityMetadata).length > 0
      ? reportMetadata.latestSourceQualityMetadata
      : reportMetadata.latestMaintenanceMetadata;
  if (!run && Object.keys(metadata).length === 0) return null;
  const counts = metadataCounts(metadata);
  const rejectionSource =
    objectValue(metadata.rejection_counts).reason ||
    metadata.rejection_counts ||
    counts.rejection_counts ||
    counts.rejected_by_reason;
  return {
    label:
      cleanText(metadata.profile) ||
      cleanText(metadata.kind) ||
      cleanText(run?.worker_name) ||
      "source-quality",
    status: cleanText(run?.status) || cleanText(metadata.status) || "unknown",
    startedAt: cleanText(run?.started_at || metadata.started_at) || null,
    finishedAt: cleanText(run?.finished_at || metadata.finished_at) || null,
    apply: boolValue(metadata.apply ?? counts.apply),
    candidatesFound: nullableNumber(
      counts.candidates_found ??
        counts.candidates ??
        counts.rejected ??
        metadata.rejected ??
        metadata.suppressible_events,
    ),
    movedToReviewLater: nullableNumber(
      counts.moved_to_review_later ?? counts.applied ?? metadata.applied,
    ),
    skippedManualProtected: nullableNumber(
      counts.skipped_manual_protected ?? counts.skipped_manual ?? metadata.skipped_manual_protected,
    ),
    rejectedByReason: reasonCounts(rejectionSource),
  };
}

function maintenancePhases(metadata: Record<string, unknown>) {
  const phases = Array.isArray(metadata.phases) ? metadata.phases : [];
  return phases.map((phase) => objectValue(phase));
}

function metadataCounts(metadata: Record<string, unknown>) {
  return objectValue(metadata.counts);
}

function getPath(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    const object = objectValue(current);
    if (!(key in object)) return undefined;
    current = object[key];
  }
  return current;
}

function numberFromPaths(metadata: Record<string, unknown>, paths: string[][]) {
  for (const path of paths) {
    const value = getPath(metadata, path);
    const parsed = nullableNumber(value);
    if (parsed !== null) return parsed;
  }
  return 0;
}

function numberValue(value: unknown) {
  return nullableNumber(value) || 0;
}

function nullableNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function boolValue(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
  }
  return null;
}

function reasonCounts(value: unknown) {
  if (Array.isArray(value)) {
    const map = new Map<string, number>();
    for (const item of value) {
      const object = objectValue(item);
      const reason = cleanText(object.reason || object.key || object.label || item) || "unknown";
      const count = nullableNumber(object.count || object.value) || 1;
      incrementMap(map, reason, count);
    }
    return reasonCountsFromMap(map);
  }

  const object = objectValue(value);
  const map = new Map<string, number>();
  for (const [reason, count] of Object.entries(object)) {
    incrementMap(map, reason, numberValue(count));
  }
  return reasonCountsFromMap(map);
}

function incrementMap(map: Map<string, number>, key: unknown, amount = 1) {
  const reason = cleanText(key) || "unknown";
  map.set(reason, (map.get(reason) || 0) + amount);
}

function reasonCountsFromMap(map: Map<string, number>) {
  return [...map.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function isMissingRelationError(message: string) {
  return /schema cache|does not exist|could not find the table|could not find.*column|column .* does not exist|42P01|42703|PGRST/i.test(
    message,
  );
}

function emptyVisualReviewStatusCounts() {
  return Object.fromEntries(visualReviewStatuses.map((status) => [status, 0])) as Record<
    VisualReviewStatus,
    number
  >;
}

function visualReviewBatchUnavailable(warning: string): VisualReviewBatchSummary {
  return {
    configured: false,
    warning,
    statusCounts: emptyVisualReviewStatusCounts(),
    latestBatchName: null,
    model: null,
    requestCount: 0,
    submittedAt: null,
    completedAt: null,
    estimatedCostUsd: 0,
    actualUsage: {},
    actualCostUsd: null,
  };
}

function cleanStatus(value: unknown): VisualReviewStatus | null {
  const status = cleanText(value);
  return visualReviewStatuses.includes(status as VisualReviewStatus)
    ? (status as VisualReviewStatus)
    : null;
}

function dateMs(value: string) {
  const ms = value ? new Date(value).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function suppressionUnavailable(warning: string): SuppressionSummary {
  return {
    configured: false,
    warning,
    suppressedChangeEvents: 0,
    suppressionReasons: [],
    latestSuppressedEvents: [],
  };
}

function percentNumber(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

export function formatCommand(parts: string[]) {
  return parts.map(formatCommandPart).join(" ");
}

export function safeCostCap(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_BASELINE_COST_CAP_USD;
  return Math.min(100, Math.round(parsed * 100) / 100);
}

function maintenanceEnvArgs(workerAppDir: string) {
  if (!workerAppDir) return [];
  const explicit = cleanText(process.env.AWARDPING_MAINTENANCE_ENV_FILE);
  if (explicit) return ["--env", explicit];
  if (existsSync(join(workerAppDir, ".env.worker.local"))) return ["--env", ".env.worker.local"];
  if (existsSync(join(workerAppDir, ".env.local"))) return ["--env", ".env.local"];
  return [];
}

function maintenanceReportPhase(value: unknown): MaintenanceReportPhase | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const phase = value as Record<string, unknown>;
  return {
    name: cleanText(phase.name),
    status: cleanText(phase.status),
    started_at: cleanText(phase.started_at),
    finished_at:
      typeof phase.finished_at === "string"
        ? phase.finished_at
        : phase.finished_at === null
          ? null
          : undefined,
    exit_code: typeof phase.exit_code === "number" ? phase.exit_code : null,
    log_path: cleanText(phase.log_path),
  };
}

function defaultLocalWorkerAppDir() {
  return process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "AwardPingWorker", "app")
    : "";
}

function isHostedRuntime() {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.NETLIFY ||
      process.env.K_SERVICE,
  );
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatCommandPart(value: string) {
  if (/^[A-Za-z0-9_./:=,-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
