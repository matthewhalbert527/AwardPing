import { buildSourceAiCoverageRow } from "./ai-review-coverage.mjs";
import { validateHistoricalLocalizationInventory } from "./manual-quarantine.mjs";
import { visualReviewFailureRetryDecision } from "./visual-review-queue.mjs";

export const ONE_TIME_CATCHUP_MODEL = "gemini-2.5-flash-lite";
export const ONE_TIME_CATCHUP_BATCH_MODE = "batch";

const DEFAULT_SOURCE_COST_PER_REQUEST_USD = 0.002;
const DEFAULT_PAGE_AUDIT_COST_PER_REQUEST_USD = 0.00035;

export function nextSourceAiStagnantCycles({
  previous = 0,
  before = 0,
  after = 0,
  activeBatches = 0,
  submitted = 0,
} = {}) {
  if (Number(after) < Number(before)) return 0;
  const current = Math.max(0, Math.floor(Number(previous) || 0));
  if (Number(activeBatches) > 0 || Number(submitted) > 0) return current;
  return current + 1;
}

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
  const sourceAiEvidenceMissingVisuals = sourceAiRows.filter(
    (row) => !row.monitor_eligible && !snapshotIds.has(row.source_id),
  );

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
  const terminalPageAuditRows = latestUnresolvedAuditErrors.filter((audit) =>
    pageAuditReachedRetryLimit(audit, audits),
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

  const activeVisualReviewCandidates = visualReviewCandidates.filter((candidate) =>
    activeAwardIds.has(candidate.shared_award_id),
  );
  const failedVisualRows = activeVisualReviewCandidates.filter(
    (candidate) => cleanKey(candidate.status) === "failed",
  );
  const failedVisualDecisions = failedVisualRows.map((candidate) => ({
    candidate,
    decision: visualReviewFailureRetryDecision(candidate, { maxRetries: 3 }),
  }));
  const retryableVisualFailures = failedVisualDecisions
    .filter(({ decision }) =>
      decision.retry || decision.reason === "awaiting_missing_batch_response_recovery"
    )
    .map(({ candidate }) => candidate);
  const terminalVisualFailures = failedVisualDecisions
    .filter(({ decision }) =>
      [
        "failure_retry_limit_reached",
        "possible_external_batch_requires_manual_recovery",
      ].includes(decision.reason)
    )
    .map(({ candidate }) => candidate);
  const visualQueueRows = [
    ...activeVisualReviewCandidates.filter((candidate) =>
      ["pending", "submitted", "processing", "succeeded"].includes(cleanKey(candidate.status)),
    ),
    ...retryableVisualFailures,
  ];
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
    sources_needing_capture_baseline: sourceAiEvidenceMissingVisuals.length,
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
    visual_review_retryable_failures: retryableVisualFailures.length,
    visual_review_terminal_failures: terminalVisualFailures.length,
    visual_review_estimated_cost_usd: roundUsd(visualEstimatedCostUsd),
    source_category_counts: categoryCounts,
    snapshot_localization_audit_pending: localizationAudited ? 0 : 1,
    snapshot_localization_latest_pending: localizationAudited
      ? nonNegativeInt(localization.latest_repair_needed, 0)
      : monitorEligibleRows.length,
    snapshot_localization_previous_pending: localizationAudited
      ? nonNegativeInt(localization.previous_repair_needed, 0)
      : 0,
    snapshot_localization_historical_unavailable: localizationAudited
      ? nonNegativeInt(localization.historical_layout_unavailable, 0)
      : 0,
    snapshot_localization_work_pending: localizationAudited
      ? nonNegativeInt(
          localization.repair_needed_versions,
          nonNegativeInt(localization.latest_repair_needed, 0) +
            nonNegativeInt(localization.previous_repair_needed, 0),
        )
      : monitorEligibleRows.length,
    snapshot_localization_exact_coverage_percent: localizationAudited
      ? nonNegativeNumber(localization.exact_coverage_percent, 0)
      : 0,
  };

  const quarantine = buildOneTimeCatchupQuarantineSummary({
    unresolvedAuditRows: latestUnresolvedAuditErrors,
    latestFailedReconciliationRows: latestFailedReconciliations,
    terminalPageAuditRows,
    terminalVisualFailureRows: terminalVisualFailures,
    snapshotLocalization: localization,
  });

  return {
    backlog,
    source_ai_rows: sourceAiRows,
    source_review_later_rows: sourceReviewLaterRows,
    source_ai_evidence_missing_visual_rows: sourceAiEvidenceMissingVisuals,
    monitor_eligible_missing_visual_rows: monitorEligibleMissingVisuals,
    latest_failed_reconciliation_rows: latestFailedReconciliations,
    unresolved_audit_rows: latestUnresolvedAuditErrors,
    terminal_page_audit_rows: terminalPageAuditRows,
    retryable_visual_failure_rows: retryableVisualFailures,
    terminal_visual_failure_rows: terminalVisualFailures,
    quarantine,
    completion: catchupCompletionDecision(backlog, quarantine),
  };
}

export function buildOneTimeCatchupQuarantineSummary({
  unresolvedAuditRows = [],
  latestFailedReconciliationRows = [],
  terminalPageAuditRows = [],
  terminalVisualFailureRows = [],
  snapshotLocalization = {},
} = {}) {
  const publicPageCaseKeys = new Set([
    ...unresolvedAuditRows.map((row) => cleanText(row?.shared_award_id)).filter(Boolean),
    ...latestFailedReconciliationRows
      .map((row) => cleanText(row?.shared_award_id))
      .filter(Boolean),
  ]);
  const visualCaseKeys = new Set(
    terminalVisualFailureRows
      .map((row) => cleanText(row?.id) || cleanText(row?.candidate_signature))
      .filter(Boolean),
  );
  const terminalPublicPageCaseKeys = new Set([
    ...latestFailedReconciliationRows
      .map((row) => cleanText(row?.shared_award_id))
      .filter(Boolean),
    ...terminalPageAuditRows
      .map((row) => cleanText(row?.shared_award_id))
      .filter(Boolean),
  ]);
  const historicalInventory = validateHistoricalLocalizationInventory(
    snapshotLocalization,
    { requireAudited: true },
  );
  const historicalInventoryComplete = historicalInventory.complete;
  const historicalCount = historicalInventoryComplete
    ? historicalInventory.declaredCount
    : null;
  const publicPageEvidenceRecords =
    unresolvedAuditRows.length + latestFailedReconciliationRows.length;
  const visualEvidenceRecords = terminalVisualFailureRows.length;

  return {
    schema_version: "manual-quarantine-registry-v1",
    quarantined_work_remaining: publicPageCaseKeys.size + visualCaseKeys.size,
    quarantine_evidence_records: publicPageEvidenceRecords + visualEvidenceRecords,
    historical_limitations: historicalCount,
    historical_inventory_status: historicalInventoryComplete ? "complete" : "not_imported",
    terminal_failures_requiring_action:
      latestFailedReconciliationRows.length +
      terminalPageAuditRows.length +
      terminalVisualFailureRows.length,
    by_category: {
      public_page: {
        cases: publicPageCaseKeys.size,
        evidence_records: publicPageEvidenceRecords,
        terminal_cases: terminalPublicPageCaseKeys.size,
        terminal_failures:
          latestFailedReconciliationRows.length + terminalPageAuditRows.length,
      },
      visual_review: {
        cases: visualCaseKeys.size,
        evidence_records: visualEvidenceRecords,
        terminal_cases: visualCaseKeys.size,
        terminal_failures: terminalVisualFailureRows.length,
      },
      historical_localization: {
        cases: historicalCount,
        evidence_records: historicalCount,
        terminal_cases: 0,
        terminal_failures: 0,
      },
    },
  };
}

export function estimateOneTimeCatchup({
  backlog,
  recentBaselineWorkerRuns = [],
  currentGeminiSpendUsd = 0,
  dailyCostCapUsd = 5,
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
  const visualMissing =
    nonNegativeInt(backlog?.monitor_eligible_missing_visuals, 0) +
    nonNegativeInt(backlog?.sources_needing_capture_baseline, 0);
  const reconciliationAwards = nonNegativeInt(backlog?.awards_to_seed_for_reconciliation, 0);
  const localizationSources = nonNegativeInt(
    backlog?.snapshot_localization_work_pending ?? backlog?.snapshot_localization_latest_pending,
    0,
  );

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

export function catchupCompletionDecision(backlog = {}, quarantine = {}) {
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
    snapshot_localization_previous_pending: nonNegativeInt(
      backlog.snapshot_localization_previous_pending,
      0,
    ),
  };
  const automatedWorkClear = Object.values(automatedBlockers).every((value) => value === 0);
  return {
    status: automatedWorkClear ? "automated_work_clear" : "automated_work_remaining",
    automated_work_clear: automatedWorkClear,
    automated_blockers: automatedBlockers,
    quarantined_work_remaining: nonNegativeInt(
      quarantine.quarantined_work_remaining,
      0,
    ),
    quarantine_evidence_records: nonNegativeInt(
      quarantine.quarantine_evidence_records,
      0,
    ),
    historical_limitations:
      quarantine.historical_limitations == null
        ? null
        : nonNegativeInt(quarantine.historical_limitations, 0),
    historical_inventory_status:
      quarantine.historical_inventory_status === "complete"
        ? "complete"
        : "not_imported",
    terminal_failures_requiring_action: nonNegativeInt(
      quarantine.terminal_failures_requiring_action,
      0,
    ),
    quarantine_by_category: objectValue(quarantine.by_category),
  };
}

export function completionFromManualQuarantineState(
  completion = {},
  registryState = {},
) {
  const state = objectValue(registryState);
  if (typeof state.automated_work_clear !== "boolean") {
    throw new Error("Manual quarantine state is missing automated_work_clear.");
  }
  const expectedStatus = state.automated_work_clear
    ? "automated_work_clear"
    : "automated_work_remaining";
  if (state.completion_status !== expectedStatus) {
    throw new Error("Manual quarantine completion status contradicts automated_work_clear.");
  }
  const historicalInventoryStatus =
    state.historical_inventory_status === "complete"
      ? "complete"
      : state.historical_inventory_status === "not_imported"
        ? "not_imported"
        : null;
  if (!historicalInventoryStatus) {
    throw new Error("Manual quarantine state has an invalid historical inventory status.");
  }
  if (
    !state.by_category ||
    typeof state.by_category !== "object" ||
    Array.isArray(state.by_category)
  ) {
    throw new Error("Manual quarantine state is missing category accounting.");
  }
  const byCategory = state.by_category;

  return {
    ...completion,
    status: expectedStatus,
    automated_work_clear: state.automated_work_clear,
    automated_blockers: objectValue(state.automated_blockers),
    quarantined_work_remaining: requiredNonNegativeInteger(
      state.quarantined_work_remaining,
      "quarantined_work_remaining",
    ),
    quarantine_evidence_records: requiredNonNegativeInteger(
      state.quarantine_evidence_records,
      "quarantine_evidence_records",
    ),
    historical_limitations:
      historicalInventoryStatus === "complete"
        ? requiredNonNegativeInteger(
            state.historical_limitations,
            "historical_limitations",
          )
        : null,
    historical_inventory_status: historicalInventoryStatus,
    terminal_failures_requiring_action: requiredNonNegativeInteger(
      state.terminal_failures_requiring_action,
      "terminal_failures_requiring_action",
    ),
    quarantine_by_category: byCategory,
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

function requiredNonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Manual quarantine state has an invalid ${field}.`);
  }
  return number;
}

function pageAuditReachedRetryLimit(audit, audits, maxAttempts = 2) {
  if (cleanKey(audit?.audit_kind) !== "gemini-batch") return false;
  const requestKey = cleanText(audit?.gemini_batch_request_key);
  if (!requestKey) return false;
  const attempts = audits.filter(
    (candidate) =>
      cleanKey(candidate?.audit_kind) === "gemini-batch" &&
      cleanText(candidate?.gemini_batch_request_key) === requestKey,
  );
  if (attempts.length < Math.max(1, nonNegativeInt(maxAttempts, 2))) return false;
  if (attempts.some((candidate) => candidate?.ai_result == null)) return false;
  return attempts.every((candidate) => {
    const result = objectValue(candidate?.ai_result);
    return ["invalid-json", "missing-batch-response"].includes(cleanKey(result.error));
  });
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
