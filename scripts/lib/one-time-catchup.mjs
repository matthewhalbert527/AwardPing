import { buildSourceAiCoverageRow } from "./ai-review-coverage.mjs";

export const ONE_TIME_CATCHUP_MODEL = "gemini-2.5-flash-lite";
export const ONE_TIME_CATCHUP_BATCH_MODE = "batch";

const DEFAULT_SOURCE_COST_PER_REQUEST_USD = 0.002;
const DEFAULT_PAGE_AUDIT_COST_PER_REQUEST_USD = 0.00035;

export function summarizeOneTimeCatchupBacklog({
  awards = [],
  sources = [],
  pageAudits = [],
  reconciliationQueue = [],
  visualReviewCandidates = [],
  visualSnapshotSourceIds = new Set(),
  snapshotLocalization = null,
} = {}) {
  const activeAwards = awards.filter((award) => award?.status === "active");
  const activeAwardIds = new Set(activeAwards.map((award) => award.id));
  const awardById = new Map(activeAwards.map((award) => [award.id, award]));
  const openSources = sources
    .filter((source) => source?.admin_review_status === "open")
    .filter((source) => activeAwardIds.has(source.shared_award_id));
  const coverageRows = openSources.map((source) =>
    buildSourceAiCoverageRow(source, awardById.get(source.shared_award_id) || null),
  );
  const sourceAiRows = coverageRows.filter((row) => row.planned_action === "queue_ai_review");
  const sourceReviewLaterRows = coverageRows.filter((row) => row.planned_action === "move_to_review_later");
  const monitorEligibleRows = coverageRows.filter((row) => row.monitor_eligible);
  const snapshotIds = visualSnapshotSourceIds instanceof Set
    ? visualSnapshotSourceIds
    : new Set(visualSnapshotSourceIds || []);
  const monitorEligibleMissingVisuals = monitorEligibleRows.filter((row) => !snapshotIds.has(row.source_id));

  const queueRows = reconciliationQueue.filter((row) => activeAwardIds.has(row.shared_award_id));
  const latestQueueByAward = latestRowsBy(queueRows, "shared_award_id");
  const activeQueueRows = queueRows.filter((row) => ["pending", "processing"].includes(cleanKey(row.status)));
  const awardsWithQueueHistory = new Set(queueRows.map((row) => row.shared_award_id));
  const awardsNeverReconciled = activeAwards.filter((award) => !awardsWithQueueHistory.has(award.id));
  const latestFailedReconciliations = [...latestQueueByAward.values()].filter(
    (row) => cleanKey(row.status) === "failed",
  );

  const audits = pageAudits.filter((audit) => activeAwardIds.has(audit.shared_award_id));
  const latestAuditByAward = latestRowsBy(audits, "shared_award_id");
  const awardsNeverAudited = activeAwards.filter((award) => !latestAuditByAward.has(award.id));
  const latestUnresolvedAuditErrors = [...latestAuditByAward.values()].filter((audit) =>
    !audit.resolved_at &&
    ["failed", "needs-review"].includes(cleanKey(audit.audit_status)) &&
    ["critical", "error"].includes(cleanKey(audit.severity)),
  );
  const pageAuditBatchInFlight = audits.filter((audit) =>
    cleanKey(audit.audit_kind) === "gemini-batch" &&
    Boolean(audit.gemini_batch_name) &&
    !audit.ai_result,
  );
  const deterministicAuditCandidates = [...latestAuditByAward.values()].filter((audit) =>
    cleanKey(audit.audit_kind) === "deterministic" &&
    !audit.resolved_at &&
    ["warnings", "failed", "needs-review"].includes(cleanKey(audit.audit_status)),
  );

  const visualQueueRows = visualReviewCandidates.filter((candidate) =>
    ["pending", "submitted", "processing", "succeeded"].includes(cleanKey(candidate.status)),
  );
  const visualEstimatedCostUsd = visualQueueRows.reduce(
    (total, candidate) => total + nonNegativeNumber(candidate.estimated_cost_usd, 0),
    0,
  );
  const awardsMissingPublicFacts = activeAwards.filter((award) => !objectHasKeys(award.public_facts));
  const categoryCounts = countBy(coverageRows, (row) => row.category);
  const localization = objectValue(snapshotLocalization);
  const localizationAudited = localization.audited === true;

  const backlog = {
    active_awards: activeAwards.length,
    open_sources: openSources.length,
    source_ai_reviews: sourceAiRows.length,
    sources_to_review_later: sourceReviewLaterRows.length,
    monitor_eligible_sources: monitorEligibleRows.length,
    monitor_eligible_missing_visuals: monitorEligibleMissingVisuals.length,
    sources_needing_capture_baseline: nonNegativeInt(categoryCounts.needs_capture_baseline, 0),
    awards_missing_public_facts: awardsMissingPublicFacts.length,
    reconciliation_active_rows: activeQueueRows.length,
    reconciliation_latest_failed_awards: latestFailedReconciliations.length,
    awards_never_reconciled: awardsNeverReconciled.length,
    awards_to_seed_for_reconciliation: activeAwards.length,
    awards_never_audited: awardsNeverAudited.length,
    latest_unresolved_audit_errors: latestUnresolvedAuditErrors.length,
    deterministic_page_audit_candidates: deterministicAuditCandidates.length,
    page_audit_batch_in_flight: pageAuditBatchInFlight.length,
    visual_review_queue: visualQueueRows.length,
    visual_review_estimated_cost_usd: roundUsd(visualEstimatedCostUsd),
    source_category_counts: categoryCounts,
    snapshot_localization_audit_pending: localizationAudited ? 0 : 1,
    snapshot_localization_latest_pending: localizationAudited
      ? nonNegativeInt(localization.latest_repair_needed, 0)
      : monitorEligibleRows.length,
    snapshot_localization_historical_unavailable: localizationAudited
      ? nonNegativeInt(localization.historical_layout_unavailable, 0)
      : 0,
    snapshot_localization_exact_coverage_percent: localizationAudited
      ? nonNegativeNumber(localization.exact_coverage_percent, 0)
      : 0,
  };

  return {
    backlog,
    source_ai_rows: sourceAiRows,
    source_review_later_rows: sourceReviewLaterRows,
    monitor_eligible_missing_visual_rows: monitorEligibleMissingVisuals,
    latest_failed_reconciliation_rows: latestFailedReconciliations,
    unresolved_audit_rows: latestUnresolvedAuditErrors,
    completion: catchupCompletionDecision(backlog),
  };
}

export function estimateOneTimeCatchup({
  backlog,
  recentBaselineWorkerRuns = [],
  currentGeminiSpendUsd = 0,
  dailyCostCapUsd = 15,
  sourceBatchSize = 250,
  sourceParallelJobs = 4,
  pageAuditBatchSize = 100,
  localizationShards = 3,
} = {}) {
  const sourceCostPerRequestUsd = observedSourceCostPerRequest(recentBaselineWorkerRuns);
  const observedWaveMinutes = observedSourceBatchWaveMinutes(recentBaselineWorkerRuns);
  const sourceRequests = nonNegativeInt(backlog?.source_ai_reviews, 0);
  const pageAuditRequests = Math.max(
    nonNegativeInt(backlog?.deterministic_page_audit_candidates, 0),
    nonNegativeInt(backlog?.latest_unresolved_audit_errors, 0),
  );
  const visualCostUsd = nonNegativeNumber(backlog?.visual_review_estimated_cost_usd, 0);
  const sourceCostUsd = sourceRequests * sourceCostPerRequestUsd;
  const pageAuditCostUsd = pageAuditRequests * DEFAULT_PAGE_AUDIT_COST_PER_REQUEST_USD;
  const estimatedCostUsd = sourceCostUsd + pageAuditCostUsd + visualCostUsd;
  const sourceRequestsPerWave = Math.max(1, sourceBatchSize * sourceParallelJobs);
  const sourceWaves = sourceRequests ? Math.ceil(sourceRequests / sourceRequestsPerWave) : 0;
  const pageAuditWaves = pageAuditRequests ? Math.ceil(pageAuditRequests / Math.max(1, pageAuditBatchSize)) : 0;
  const visualMissing = nonNegativeInt(backlog?.monitor_eligible_missing_visuals, 0);
  const reconciliationAwards = nonNegativeInt(backlog?.awards_to_seed_for_reconciliation, 0);
  const localizationSources = nonNegativeInt(backlog?.snapshot_localization_latest_pending, 0);

  const sourceLowMinutes = sourceWaves * Math.max(15, observedWaveMinutes * 0.7);
  const sourceHighMinutes = sourceWaves * Math.max(60, observedWaveMinutes * 2);
  const captureLowMinutes = (visualMissing * 4) / 60;
  const captureHighMinutes = (visualMissing * 15) / 60;
  const reconciliationLowMinutes = (reconciliationAwards * 0.75) / 60;
  const reconciliationHighMinutes = (reconciliationAwards * 4) / 60;
  const auditLowMinutes = pageAuditWaves * 10;
  const auditHighMinutes = pageAuditWaves * 45;
  const housekeepingLowMinutes = 20;
  const housekeepingHighMinutes = 60;
  const localizationWorkers = Math.max(1, nonNegativeInt(localizationShards, 3));
  const localizationLowMinutes = (localizationSources * 4) / 60 / localizationWorkers;
  const localizationHighMinutes = (localizationSources * 10) / 60 / localizationWorkers;
  const lowMinutes = sourceLowMinutes + captureLowMinutes + reconciliationLowMinutes + auditLowMinutes + localizationLowMinutes + housekeepingLowMinutes;
  const highMinutes = sourceHighMinutes + captureHighMinutes + reconciliationHighMinutes + auditHighMinutes + localizationHighMinutes + housekeepingHighMinutes;
  const cap = nonNegativeNumber(dailyCostCapUsd, 0);
  const spent = nonNegativeNumber(currentGeminiSpendUsd, 0);
  const billingWindows = cap > 0 ? Math.max(1, Math.ceil((spent + estimatedCostUsd) / cap)) : 1;

  return {
    model: ONE_TIME_CATCHUP_MODEL,
    gemini_mode: ONE_TIME_CATCHUP_BATCH_MODE,
    source_ai_requests: sourceRequests,
    source_batch_waves: sourceWaves,
    source_requests_per_wave: sourceRequestsPerWave,
    page_audit_requests: pageAuditRequests,
    page_audit_waves: pageAuditWaves,
    source_cost_per_request_usd: roundUsd(sourceCostPerRequestUsd),
    estimated_source_cost_usd: roundUsd(sourceCostUsd),
    estimated_page_audit_cost_usd: roundUsd(pageAuditCostUsd),
    estimated_visual_review_cost_usd: roundUsd(visualCostUsd),
    estimated_total_cost_usd: roundUsd(estimatedCostUsd),
    estimated_cost_range_usd: {
      low: roundUsd(estimatedCostUsd * 0.8),
      high: roundUsd(estimatedCostUsd * 1.3),
    },
    current_gemini_spend_usd: roundUsd(spent),
    daily_cost_cap_usd: roundUsd(cap),
    estimated_billing_windows: billingWindows,
    snapshot_localization_sources: localizationSources,
    snapshot_localization_shards: localizationWorkers,
    estimated_snapshot_localization_hours: {
      low: roundOne(localizationLowMinutes / 60),
      high: roundOne(localizationHighMinutes / 60),
    },
    observed_source_batch_wave_minutes: roundOne(observedWaveMinutes),
    expected_time_hours: {
      low: roundOne(lowMinutes / 60),
      high: roundOne(highMinutes / 60),
    },
    conservative_external_batch_sla_hours: 24,
  };
}

export function catchupCompletionDecision(backlog = {}) {
  const automatedBlockers = {
    source_ai_reviews: nonNegativeInt(backlog.source_ai_reviews, 0),
    sources_to_review_later: nonNegativeInt(backlog.sources_to_review_later, 0),
    monitor_eligible_missing_visuals: nonNegativeInt(backlog.monitor_eligible_missing_visuals, 0),
    sources_needing_capture_baseline: nonNegativeInt(backlog.sources_needing_capture_baseline, 0),
    reconciliation_active_rows: nonNegativeInt(backlog.reconciliation_active_rows, 0),
    awards_never_reconciled: nonNegativeInt(backlog.awards_never_reconciled, 0),
    awards_never_audited: nonNegativeInt(backlog.awards_never_audited, 0),
    page_audit_batch_in_flight: nonNegativeInt(backlog.page_audit_batch_in_flight, 0),
    visual_review_queue: nonNegativeInt(backlog.visual_review_queue, 0),
    snapshot_localization_audit_pending: nonNegativeInt(
      backlog.snapshot_localization_audit_pending,
      0,
    ),
    snapshot_localization_latest_pending: nonNegativeInt(
      backlog.snapshot_localization_latest_pending,
      0,
    ),
  };
  const automatedComplete = Object.values(automatedBlockers).every((value) => value === 0);
  const manualReviewCount = nonNegativeInt(backlog.latest_unresolved_audit_errors, 0);
  const historicalLocalizationFallbacks = nonNegativeInt(
    backlog.snapshot_localization_historical_unavailable,
    0,
  );
  return {
    automated_complete: automatedComplete,
    steady_state_ready: automatedComplete,
    status: automatedComplete
      ? manualReviewCount > 0
        ? "complete_with_safe_manual_review"
        : "complete"
      : "catchup_required",
    automated_blockers: automatedBlockers,
    safe_manual_review_items: manualReviewCount,
    historical_localization_fallbacks: historicalLocalizationFallbacks,
  };
}

export function observedSourceCostPerRequest(workerRuns = []) {
  let totalCost = 0;
  let totalRequests = 0;
  for (const run of workerRuns.slice(0, 20)) {
    const metadata = objectValue(run?.metadata);
    const usage = objectValue(metadata.gemini_usage);
    const requests = nonNegativeInt(usage.batch_submitted_requests, 0);
    const cost = nonNegativeNumber(usage.estimated_cost_usd, 0);
    const model = cleanText(metadata.ai_model || usage.model);
    if (!requests || !cost || (model && model !== ONE_TIME_CATCHUP_MODEL)) continue;
    totalRequests += requests;
    totalCost += cost;
  }
  if (!totalRequests) return DEFAULT_SOURCE_COST_PER_REQUEST_USD;
  return clamp(totalCost / totalRequests, 0.00025, 0.01);
}

export function observedSourceBatchWaveMinutes(workerRuns = []) {
  const durations = [];
  for (const run of workerRuns.slice(0, 20)) {
    const metadata = objectValue(run?.metadata);
    const usage = objectValue(metadata.gemini_usage);
    if (!nonNegativeInt(usage.batch_submitted_requests, 0)) continue;
    const started = Date.parse(run.started_at || "");
    const finished = Date.parse(run.finished_at || "");
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) continue;
    durations.push((finished - started) / 60_000);
  }
  if (!durations.length) return 45;
  durations.sort((left, right) => left - right);
  return clamp(durations[Math.floor(durations.length / 2)], 10, 120);
}

function latestRowsBy(rows, key) {
  const sorted = [...rows].sort((left, right) => dateNumber(right.created_at) - dateNumber(left.created_at));
  const latest = new Map();
  for (const row of sorted) {
    const value = row?.[key];
    if (value && !latest.has(value)) latest.set(value, row);
  }
  return latest;
}

function countBy(rows, picker) {
  const counts = {};
  for (const row of rows) {
    const key = cleanText(picker(row)) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => Number(right[1]) - Number(left[1])));
}

function dateNumber(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectHasKeys(value) {
  return Object.keys(objectValue(value)).length > 0;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function nonNegativeInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundUsd(value) {
  return Math.round(nonNegativeNumber(value, 0) * 1_000_000) / 1_000_000;
}

function roundOne(value) {
  return Math.round(nonNegativeNumber(value, 0) * 10) / 10;
}
