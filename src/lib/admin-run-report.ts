import type { Database } from "@/lib/database.types";
import { isScheduledNightlyVisualRun } from "../../scripts/lib/visual-nightly-run-contract.mjs";
import {
  validateVisualSourceInventoryCohort,
  validateVisualSourceInventoryProof,
} from "../../scripts/lib/visual-source-inventory-proof.mjs";

export type WorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

export type RunReportItem = {
  key: string;
  label: string;
  value: number;
  detail: string;
  tone: "neutral" | "positive" | "attention";
};

export type RunReportDigest = {
  id: string;
  title: string;
  summary: string;
  status: "running" | "succeeded" | "degraded" | "failed";
  isRunning: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  items: RunReportItem[];
};

export type VisualNightlyStatus =
  | "scheduled"
  | "running"
  | "healthy"
  | "degraded"
  | "failed"
  | "incomplete"
  | "missed";

export type VisualNightlyShard = {
  runId: string;
  shardNumber: number;
  shardCount: number;
  status: "running" | "healthy" | "degraded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  checked: number;
  failed: number;
  loaded: number;
  processed: number;
  inventoryComplete: boolean;
  inventoryProofComplete: boolean;
  inventoryProofReason: string;
  globalSourceCount: number | null;
  globalSourceHash: string | null;
  expectedShardSourceCount: number | null;
  expectedShardSourceHash: string | null;
  loadedShardSourceCount: number | null;
  loadedShardSourceHash: string | null;
  incidents: number;
  stalled: boolean;
};

export type VisualNightlyFailureGroup = {
  code: string;
  label: string;
  severity: "warning" | "critical";
  count: number;
  sourceCount: number;
  retryMode: string;
  repairCode: string;
  solution: string;
};

export type VisualNightlyReport = {
  monitoringDate: string;
  timezone: "America/Chicago";
  status: VisualNightlyStatus;
  isLatestDueWindow: boolean;
  expectedShards: number;
  observedShards: number;
  completedShards: number;
  missingShards: number[];
  loaded: number;
  checked: number;
  failed: number;
  incidents: number;
  inventoryComplete: boolean;
  inventoryProofComplete: boolean;
  globalSourceCount: number | null;
  globalSourceHash: string | null;
  partitionSourceCountSum: number | null;
  failureRatePercent: number;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string;
  shards: VisualNightlyShard[];
  failureGroups: VisualNightlyFailureGroup[];
};

export type AdminRunReportFeed = {
  current: RunReportDigest | null;
  overnight: RunReportDigest | null;
  visualNightly: VisualNightlyReport | null;
  generatedAt: string;
};

type Totals = {
  pagesChecked: number;
  candidates: number;
  published: number;
  noiseRejected: number;
  sectionsRead: number;
  failedLoads: number;
  sourcesExcluded: number;
  batchReady: number;
  batchSubmitted: number;
  awardsQueued: number;
  awardsReconciled: number;
  factsAdded: number;
};

const currentRunMaxAgeMs = 48 * 60 * 60 * 1000;

export function buildAdminRunReportFeed(
  runs: WorkerRun[],
  now = new Date(),
): AdminRunReportFeed {
  const sorted = [...runs].sort(
    (left, right) => dateMs(right.started_at) - dateMs(left.started_at),
  );
  const visualNightly = buildVisualNightlyReport(sorted, now);

  return {
    current: buildCurrentDigest(sorted, now),
    overnight: visualNightly ? visualNightlyDigest(visualNightly) : buildOvernightDigest(sorted),
    visualNightly,
    generatedAt: now.toISOString(),
  };
}

export function latestCompletedDailyRun(runs: WorkerRun[]) {
  return [...runs]
    .filter((run) => run.status !== "running" && isMaintenanceRun(run) && runProfile(run) === "daily")
    .sort((left, right) => dateMs(right.started_at) - dateMs(left.started_at))[0] || null;
}

function buildCurrentDigest(runs: WorkerRun[], now: Date): RunReportDigest | null {
  const active = runs.filter((run) => {
    if (run.status !== "running") return false;
    if (isVisualRun(run) && visualRunIsStalled(run, now)) return false;
    const ageMs = now.getTime() - dateMs(run.started_at);
    return ageMs >= 0 && ageMs <= currentRunMaxAgeMs;
  });
  if (!active.length) return null;

  const activeMaintenanceRuns = active.filter(isMaintenanceRun);
  const currentScope = activeMaintenanceRuns.length
    ? runs.filter((run) => {
        const startedAt = dateMs(run.started_at);
        const scopeStart = Math.min(
          ...activeMaintenanceRuns.map((maintenanceRun) => dateMs(maintenanceRun.started_at)),
        );
        return startedAt >= scopeStart && startedAt <= now.getTime();
      })
    : active;
  const visualRuns = currentScope.filter(isVisualRun);
  const activeVisualRuns = active.filter(isVisualRun);
  const coverageRuns = currentScope.filter(isAiCoverageRun);
  const maintenanceRuns = active.filter(isMaintenanceRun);
  const baselineRuns = currentScope.filter(isBaselineFactsRun);
  const totals = summarizeRuns(currentScope);
  const hasDaily = visualRuns.some(isDailyVisualRun) ||
    maintenanceRuns.some((run) => runProfile(run) === "daily");
  const dailyIsRunning = activeVisualRuns.some(isDailyVisualRun) ||
    maintenanceRuns.some((run) => runProfile(run) === "daily");
  const hasSetup = coverageRuns.length > 0 || maintenanceRuns.some((run) => runProfile(run) === "catchup");

  let title = "AwardPing is working";
  if (hasDaily && hasSetup) {
    title = dailyIsRunning
      ? "Daily check and setup are running"
      : "Daily check completed; setup is running";
  }
  else if (hasDaily) title = "Daily source check is running";
  else if (hasSetup) title = "Initial setup is running";
  else if (baselineRuns.length) title = "AI fact review is running";

  const summaryParts: string[] = [];
  if (visualRuns.length) {
    summaryParts.push(`${formatCount(totals.pagesChecked)} source ${plural(totals.pagesChecked, "page")} checked so far`);
    summaryParts.push(`${formatCount(totals.candidates)} change ${plural(totals.candidates, "candidate")} found`);
    summaryParts.push(`${formatCount(totals.published)} verified ${plural(totals.published, "update")} published`);
  }
  if (coverageRuns.length) {
    summaryParts.push(`${formatCount(totals.sourcesExcluded)} irrelevant or unclear sources excluded`);
    summaryParts.push(`${formatCount(totals.batchReady)} sources prepared for Batch review`);
  }
  if (!summaryParts.length) {
    summaryParts.push("The worker is active and preparing its first progress totals");
  }

  return {
    id: active.map((run) => run.id).sort().join(":"),
    title,
    summary: `${summaryParts.join("; ")}.`,
    status: "running",
    isRunning: true,
    startedAt: earliestDate(active.map((run) => run.started_at)),
    finishedAt: null,
    items: currentItems(totals, {
      hasVisual: visualRuns.length > 0,
      hasCoverage: coverageRuns.length > 0,
    }),
  };
}

export function buildVisualNightlyReport(
  runs: WorkerRun[],
  now = new Date(),
): VisualNightlyReport | null {
  const scheduledVisualRuns = [...runs]
    .filter(isScheduledDailyVisualRun)
    .sort((left, right) => dateMs(right.started_at) - dateMs(left.started_at));
  if (!scheduledVisualRuns.length) return null;

  const latestDueWindow = monitoringWindowKey(now.toISOString());
  const monitoringDate = latestDueWindow;
  const windowRuns = scheduledVisualRuns.filter(
    (run) => monitoringWindowKey(run.started_at) === monitoringDate,
  );
  const isLatestDueWindow = windowRuns.length > 0;
  const canonicalByShard = new Map<number, WorkerRun>();
  for (const run of windowRuns) {
    const shardIndex = visualShardIndex(run);
    if (shardIndex === null || canonicalByShard.has(shardIndex)) continue;
    canonicalByShard.set(shardIndex, run);
  }

  const expectedShards = Math.max(
    3,
    ...windowRuns.map(visualShardCount),
  );
  const shards = [...canonicalByShard.entries()]
    .sort(([left], [right]) => left - right)
    .map(([shardIndex, run]) => visualNightlyShard(run, shardIndex, now));
  const missingShards = Array.from({ length: expectedShards }, (_, index) => index)
    .filter((index) => !canonicalByShard.has(index))
    .map((index) => index + 1);
  const checked = sum(shards.map((shard) => shard.checked));
  const failed = sum(shards.map((shard) => shard.failed));
  const loaded = sum(shards.map((shard) => shard.loaded));
  const incidents = sum(shards.map((shard) => shard.incidents));
  const completedShards = shards.filter((shard) => Boolean(shard.finishedAt) && !shard.stalled).length;
  const inventoryProof = validateVisualSourceInventoryCohort(
    [...canonicalByShard.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, run]) => record(run.metadata).source_inventory),
    expectedShards,
  );
  let failureGroups = mergeNightlyFailureGroups(
    [...canonicalByShard.values()].flatMap(runFailureGroups),
  );
  const anyFailed = shards.some((shard) => shard.status === "failed");
  const incompleteInventoryShards = shards.filter((shard) => !shard.inventoryComplete);
  const inventoryGapShards = incompleteInventoryShards.filter((shard) =>
    shard.status !== "running" && !shard.inventoryComplete);
  const anyRunning = shards.some((shard) => shard.status === "running");
  const withinRunWindow = windowRuns.length > 0 &&
    now.getTime() - Math.min(...windowRuns.map((run) => dateMs(run.started_at))) < 3 * 60 * 60 * 1000;

  let status: VisualNightlyStatus;
  if (!isLatestDueWindow) status = withinSixPmLaunchGrace(now) ? "scheduled" : "missed";
  else if (anyFailed) status = "failed";
  else if (anyRunning) status = "running";
  else if (missingShards.length) status = withinRunWindow ? "running" : "incomplete";
  else if (!inventoryProof.complete) status = "failed";
  else if (failed > 0 || incidents > 0 || failureGroups.length > 0) status = "degraded";
  else status = "healthy";

  const syntheticFailures: VisualNightlyFailureGroup[] = [];
  if (inventoryGapShards.length) {
    syntheticFailures.push(failureResolution(
      "source_inventory_empty_or_incomplete",
      "Scheduled source inventory was not fully processed",
      "critical",
      "repair_then_restart_shard",
      "verify_inventory_then_restart_shard",
      "Compare each shard's loaded and processed source inventory, repair the source query or interrupted loop, then restart only the affected shard. A zero-page run never proves a healthy scan.",
      inventoryGapShards.length,
      0,
    ));
  }
  if (!inventoryProof.complete && shards.length === expectedShards && !anyRunning) {
    syntheticFailures.push(failureResolution(
      "source_inventory_proof_missing_or_mismatched",
      "Authoritative source inventory proofs do not form one exact cohort",
      "critical",
      "repair_then_restart_shard",
      "verify_authoritative_inventory_then_restart_shard",
      `Require all three shards to attest the same non-empty global count and hash, matching partition hashes, exact loaded hashes, and a partition-count sum equal to the global count. Proof failure: ${inventoryProof.reason}.`,
      1,
      0,
    ));
  }
  const legacyShards = [...canonicalByShard.values()].filter(isLegacyVisualRun);
  if (legacyShards.length) {
    syntheticFailures.push(failureResolution(
      "legacy_grouping_ambiguous",
      "Legacy shard cohort needs verification",
      "warning",
      "manual_investigation",
      "verify_legacy_task_history",
      "This report predates scheduled cohort IDs, so verify the Windows task times before relying on retry attribution. Newly scheduled scans are grouped unambiguously.",
      legacyShards.length,
      0,
    ));
    if (status === "healthy") status = "degraded";
  }
  const stalledShards = shards.filter((shard) => shard.stalled);
  if (stalledShards.length) {
    syntheticFailures.push(failureResolution(
      "stalled_shard",
      "Shard heartbeat stopped",
      "critical",
      "repair_then_restart_shard",
      "inspect_then_restart_stalled_shard",
      "Inspect the shard log and process lock, repair the blocking dependency, then restart only the stalled shard. Do not rerun completed shards.",
      stalledShards.length,
      0,
    ));
  }
  if (["incomplete", "missed"].includes(status) && missingShards.length) {
    syntheticFailures.push(failureResolution(
      "missing_shard",
      "Scheduled shard did not report",
      "critical",
      "repair_then_restart_shard",
      "inspect_task_then_start_missing_shard",
      "Check the missing shard's Windows Scheduled Task result and wrapper log, repair the launch failure, then start only that shard.",
      missingShards.length,
      0,
    ));
  }
  failureGroups = mergeNightlyFailureGroups([...failureGroups, ...syntheticFailures]);

  return {
    monitoringDate,
    timezone: "America/Chicago",
    status,
    isLatestDueWindow,
    expectedShards,
    observedShards: shards.length,
    completedShards,
    missingShards,
    loaded,
    checked,
    failed,
    incidents,
    inventoryComplete: shards.length === expectedShards &&
      incompleteInventoryShards.length === 0 && inventoryProof.complete,
    inventoryProofComplete: inventoryProof.complete,
    globalSourceCount: inventoryProof.globalCount,
    globalSourceHash: inventoryProof.globalHash,
    partitionSourceCountSum: inventoryProof.partitionCountSum,
    failureRatePercent: loaded ? Math.round((failed / loaded) * 10_000) / 100 : 0,
    startedAt: earliestDate(shards.map((shard) => shard.startedAt)),
    finishedAt: latestDate(shards.map((shard) => shard.finishedAt)),
    summary: visualNightlySummary({
      status,
      expectedShards,
      completedShards,
      checked,
      failed,
      missingShards,
      monitoringDate,
      failureGroups,
    }),
    shards,
    failureGroups,
  };
}

function visualNightlyDigest(report: VisualNightlyReport): RunReportDigest {
  const items: RunReportItem[] = [
    item("shards", "Shards complete", report.completedShards, `of ${report.expectedShards} scheduled`, report.completedShards === report.expectedShards ? "positive" : "attention"),
    item("checked", "Pages captured", report.checked, `${formatCount(report.loaded)} sources loaded`, "positive"),
  ];
  if (report.failed) {
    items.push(item("failures", "Source failures", report.failed, "grouped with safe repairs below", "attention"));
  }
  if (report.incidents > report.failed) {
    items.push(item("incidents", "Pipeline incidents", report.incidents - report.failed, "non-source stages needing attention", "attention"));
  }

  return {
    id: `visual-nightly:${report.monitoringDate}:${report.shards.map((shard) => shard.runId).join(":")}`,
    title: "6 PM capture scan",
    summary: report.summary,
    status: report.status === "healthy"
      ? "succeeded"
      : report.status === "degraded"
        ? "degraded"
        : ["running", "scheduled"].includes(report.status)
          ? "running"
          : "failed",
    isRunning: ["running", "scheduled"].includes(report.status),
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    items,
  };
}

function visualNightlyShard(run: WorkerRun, shardIndex: number, now: Date): VisualNightlyShard {
  const metadata = record(run.metadata);
  const runHealth = record(metadata.run_health);
  const healthStatus = cleanText(runHealth.status);
  const stalled = visualRunIsStalled(run, now);
  const checked = numberValue(run.checked_count);
  const failed = numberValue(run.failed_count);
  const loaded = loadedSourcesForRun(run);
  const processed = checked + failed +
    metric(run, ["skipped_existing_baseline"]) + metric(run, ["skipped_pdf"]);
  const inventoryProof = validateVisualSourceInventoryProof(metadata.source_inventory, {
    shardCount: visualShardCount(run),
    shardIndex,
  });
  const inventoryComplete = loaded > 0 && processed === loaded && inventoryProof.complete;
  let status: VisualNightlyShard["status"] = "healthy";
  if (stalled) status = "failed";
  else if (run.status === "running" || healthStatus === "running") status = "running";
  else if (run.status === "failed" || ["failed", "blocked"].includes(healthStatus) || !inventoryComplete) status = "failed";
  else if (run.failed_count > 0 || healthStatus === "degraded" || runFailureGroups(run).length) status = "degraded";

  return {
    runId: run.id,
    shardNumber: shardIndex + 1,
    shardCount: visualShardCount(run),
    status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    checked,
    failed,
    loaded,
    processed,
    inventoryComplete,
    inventoryProofComplete: inventoryProof.complete,
    inventoryProofReason: inventoryProof.reason,
    globalSourceCount: inventoryProof.globalCount,
    globalSourceHash: inventoryProof.globalHash,
    expectedShardSourceCount: inventoryProof.expectedShardCount,
    expectedShardSourceHash: inventoryProof.expectedShardHash,
    loadedShardSourceCount: inventoryProof.loadedShardCount,
    loadedShardSourceHash: inventoryProof.loadedShardHash,
    incidents: numberValue(runHealth.incident_count) || runErrorSamples(run).length,
    stalled,
  };
}

function visualRunIsStalled(run: WorkerRun, now: Date) {
  if (run.status !== "running") return false;

  const heartbeatAt = cleanText(record(run.metadata).heartbeat_at);
  const ageMs = now.getTime() - dateMs(heartbeatAt || run.started_at);
  const staleAfterMs = heartbeatAt
    ? 15 * 60 * 1000
    : 23 * 60 * 60 * 1000;
  return ageMs >= staleAfterMs;
}

function runFailureGroups(run: WorkerRun): VisualNightlyFailureGroup[] {
  const metadata = record(run.metadata);
  const structured = Array.isArray(metadata.failure_groups)
    ? metadata.failure_groups.map(record).filter((group) => cleanText(group.code))
    : [];
  if (structured.length) {
    return structured.map((group) => ({
      code: cleanText(group.code),
      label: cleanText(group.label) || "Worker failure",
      severity: group.severity === "warning" ? "warning" : "critical",
      count: Math.max(1, numberValue(group.count)),
      sourceCount: numberValue(group.source_id_count),
      retryMode: cleanText(group.retry_mode) || "manual_investigation",
      repairCode: cleanText(group.repair_code) || "classify_before_retry",
      solution: cleanText(group.solution) || fallbackFailureResolution("").solution,
    }));
  }

  const samples = runErrorSamples(run);
  const groups = samples.map((sample) => fallbackFailureResolution(cleanText(sample.message)));
  const unrepresented = Math.max(0, numberValue(run.failed_count) - samples.length);
  if (unrepresented) {
    groups.push({
      ...fallbackFailureResolution(""),
      count: unrepresented,
      sourceCount: unrepresented,
    });
  }
  if (!groups.length && run.error) groups.push(fallbackFailureResolution(run.error));
  return groups;
}

function runErrorSamples(run: WorkerRun) {
  const errors = record(run.metadata).errors;
  return Array.isArray(errors) ? errors.map(record) : [];
}

function fallbackFailureResolution(message: string): VisualNightlyFailureGroup {
  const lower = message.toLowerCase();
  if (lower.includes("baseline") && (lower.includes("missing") || lower.includes("could not be loaded"))) {
    return failureResolution(
      "baseline_evidence_missing_or_invalid",
      "Baseline evidence needs repair",
      "critical",
      "operator_guarded",
      "restore_or_verify_baseline_evidence",
      "Restore the complete retained baseline capture. If it is unavailable, verify the official page before a targeted baseline refresh; never refresh merely to clear the error.",
    );
  }
  if (/(gemini[^\n]{0,80}\bcap\b|quota exceeded|insufficient quota|resource.?exhausted|spend cap|billing limit)/i.test(message)) {
    return failureResolution(
      "ai_quota_or_billing_blocked",
      "AI quota or spend cap blocked the shard",
      "critical",
      "repair_then_restart_shard",
      "restore_ai_quota_then_restart",
      "Verify the AI account quota and billing state. Wait for the approved reset or increase the spend cap only with authorization, then restart only the affected shard; do not change baselines while the shared limit is active.",
    );
  }
  if (/(supabase|service.?role|billing.?blocked|missing environment|configuration is required|source load incomplete)/i.test(message)) {
    return failureResolution(
      "infra_blocked",
      "Worker dependency is unavailable",
      "critical",
      "repair_then_restart_shard",
      "restore_dependency_then_restart",
      "Restore the shared dependency or worker configuration, then restart only the affected shard. Do not change baselines while the dependency is unavailable.",
    );
  }
  if (/(candidate enqueue|reconciliation queue|publish failed|rejection ledger)/i.test(message)) {
    return failureResolution(
      "downstream_persistence_failed",
      "Downstream handoff failed",
      "critical",
      "resume_idempotently",
      "resume_downstream_handoff",
      "Retry only the failed queue, publish, or reconciliation handoff. Keep the capture and do not create a duplicate review job.",
    );
  }
  if (/(r2|object storage|snapshot upload)/i.test(message)) {
    return failureResolution(
      "storage_sync_failed",
      "Evidence storage sync failed",
      "critical",
      "retry_failed_stage",
      "repair_storage_then_resync",
      "Restore storage access and retry only the sync for retained evidence; do not recapture or advance the baseline.",
    );
  }
  if (/(http 401|http 403|access.?blocked|access denied|captcha|security.?challenge)/i.test(message)) {
    return failureResolution(
      "persistent_access_block",
      "Source blocked automated access",
      "warning",
      "manual_source_review",
      "verify_access_or_alternate_source",
      "Verify the source and access pattern manually. Never accept an access-denied or challenge page as a new baseline.",
    );
  }
  if (/(http 404|http 410|soft.?404|page not found|redirect loop)/i.test(message)) {
    return failureResolution(
      "source_gone_or_moved",
      "Official source may have moved",
      "warning",
      "manual_source_review",
      "verify_replace_or_retire_source",
      "Verify whether the official page moved; replace or retire the source only after confirmation and retain its historical evidence.",
    );
  }
  if (/(http 429|rate limit|too many requests)/i.test(message)) {
    return failureResolution(
      "rate_limited",
      "Source rate-limited the scan",
      "warning",
      "automatic_next_scan",
      "backoff_then_retry",
      "Allow the next scheduled retry with backoff. If it repeats, reduce frequency or approve a stable alternate official URL.",
    );
  }
  if (/(timeout|timed out|fetch failed|err_name_not_resolved|err_connection|http 5\d\d)/i.test(message)) {
    return failureResolution(
      "network_transient",
      "Transient network failure",
      "warning",
      "automatic_next_scan",
      "retry_after_backoff",
      "Let the next scheduled scan retry with backoff; preserve the existing baseline and investigate repeated host failures.",
    );
  }
  return failureResolution(
    "unknown_failure",
    "Unclassified worker failure",
    "critical",
    "manual_investigation",
    "classify_before_retry",
    "Inspect the exact run and retained evidence before retrying. Preserve the baseline until the failed stage is classified.",
  );
}

function failureResolution(
  code: string,
  label: string,
  severity: VisualNightlyFailureGroup["severity"],
  retryMode: string,
  repairCode: string,
  solution: string,
  count = 1,
  sourceCount = 1,
): VisualNightlyFailureGroup {
  return { code, label, severity, count, sourceCount, retryMode, repairCode, solution };
}

function mergeNightlyFailureGroups(groups: VisualNightlyFailureGroup[]) {
  const merged = new Map<string, VisualNightlyFailureGroup>();
  for (const group of groups) {
    const current = merged.get(group.code);
    if (!current) {
      merged.set(group.code, { ...group });
      continue;
    }
    current.count += group.count;
    current.sourceCount += group.sourceCount;
  }
  return [...merged.values()].sort((left, right) =>
    (right.severity === "critical" ? 1 : 0) - (left.severity === "critical" ? 1 : 0) ||
    right.count - left.count ||
    left.code.localeCompare(right.code),
  );
}

function visualNightlySummary({
  status,
  expectedShards,
  completedShards,
  checked,
  failed,
  missingShards,
  monitoringDate,
  failureGroups,
}: {
  status: VisualNightlyStatus;
  expectedShards: number;
  completedShards: number;
  checked: number;
  failed: number;
  missingShards: number[];
  monitoringDate: string;
  failureGroups: VisualNightlyFailureGroup[];
}) {
  if (status === "scheduled") return `The three 6 PM shards are within their launch grace period for ${monitoringDate}.`;
  if (status === "missed") return `No 6 PM shard report was recorded for the due ${monitoringDate} scan.`;
  if (status === "failed") {
    const primaryFailure = failureGroups.find((group) =>
      group.code === "source_inventory_proof_missing_or_mismatched") || failureGroups[0];
    const reason = cleanText(primaryFailure?.label) || "A shard or required inventory check failed";
    return `The 6 PM scan failed: ${reason}. ${completedShards}/${expectedShards} shards reported, with ${formatCount(failed)} source failures.`;
  }
  if (status === "running") return `The 6 PM scan is running. ${completedShards}/${expectedShards} shards have completed.`;
  if (status === "incomplete") return `The 6 PM scan is incomplete; ${missingShards.map((shard) => `shard ${shard}`).join(" and ")} did not report.`;
  if (status === "degraded") return `All ${expectedShards} shards completed, captured ${formatCount(checked)} pages, and recorded ${formatCount(failed)} source failures.`;
  return `All ${expectedShards} shards completed, captured ${formatCount(checked)} pages, and recorded no source failures.`;
}

function buildOvernightDigest(runs: WorkerRun[]): RunReportDigest | null {
  const parent = latestCompletedDailyRun(runs);
  if (parent) {
    const start = dateMs(parent.started_at);
    const end = dateMs(parent.finished_at) || start;
    const related = runs.filter((run) => {
      const started = dateMs(run.started_at);
      return run.id !== parent.id && started >= start && started <= end;
    });
    return completedDigest(parent, related);
  }

  const completedVisuals = runs.filter((run) => run.status !== "running" && isDailyVisualRun(run));
  if (!completedVisuals.length) return null;
  const latestKey = monitoringWindowKey(completedVisuals[0].started_at);
  const group = completedVisuals.filter((run) => monitoringWindowKey(run.started_at) === latestKey);
  const representative = group[0];
  return completedDigest(representative, group);
}

function completedDigest(parent: WorkerRun, related: WorkerRun[]): RunReportDigest {
  const rows = related.length ? related : [parent];
  const totals = summarizeRuns(rows);
  const meaningful = totals.pagesChecked + totals.published + totals.sourcesExcluded +
    totals.batchSubmitted + totals.awardsReconciled + totals.factsAdded;
  const failed = parent.status === "failed" || rows.some((run) => run.status === "failed");
  const degraded = !failed && totals.failedLoads > 0;
  let summary: string;

  if (!meaningful) {
    summary = failed
      ? "The last overnight run stopped without recording completed source-page work or public updates."
      : "The last overnight run completed, but it recorded no source-page checks, new AI interpretations, or public updates.";
  } else {
    const parts: string[] = [];
    if (totals.pagesChecked) {
      parts.push(`checked ${formatCount(totals.pagesChecked)} source ${plural(totals.pagesChecked, "page")}`);
    }
    if (totals.candidates) {
      parts.push(`found ${formatCount(totals.candidates)} change ${plural(totals.candidates, "candidate")}`);
    }
    if (totals.published) {
      parts.push(`published ${formatCount(totals.published)} verified ${plural(totals.published, "update")}`);
    }
    if (totals.sourcesExcluded) {
      parts.push(`excluded ${formatCount(totals.sourcesExcluded)} unsuitable sources`);
    }
    if (totals.factsAdded) {
      parts.push(`added ${formatCount(totals.factsAdded)} source ${plural(totals.factsAdded, "interpretation")}`);
    }
    if (totals.awardsReconciled) {
      parts.push(`rebuilt ${formatCount(totals.awardsReconciled)} award ${plural(totals.awardsReconciled, "page")}`);
    }
    summary = `The last overnight run ${joinSummaryParts(parts)}.`;
  }

  return {
    id: `overnight:${parent.id}`,
    title: "Last overnight run",
    summary,
    status: failed ? "failed" : degraded ? "degraded" : "succeeded",
    isRunning: false,
    startedAt: parent.started_at,
    finishedAt: parent.finished_at,
    items: completedItems(totals),
  };
}

function summarizeRuns(runs: WorkerRun[]): Totals {
  const visualRuns = runs.filter(isVisualRun);
  const coverageRuns = runs.filter(isAiCoverageRun);
  const totals: Totals = {
    pagesChecked: sum(visualRuns.map((run) => run.checked_count)),
    candidates: sum(visualRuns.map((run) => metric(run, ["candidate_changes"]))),
    published: sum(visualRuns.map((run) => Math.max(
      metric(run, ["published_updates"]),
      metric(run, ["ai_true_changes"]),
    ))),
    noiseRejected: sum(visualRuns.map((run) =>
      metric(run, ["deterministic_source_rejected"]) +
      metric(run, ["deterministic_noise_rejected"]),
    )),
    sectionsRead: sum(visualRuns.map((run) => metric(run, ["expandable_sections_extracted"]))),
    failedLoads: sum(visualRuns.map((run) => run.failed_count)),
    sourcesExcluded: max(coverageRuns.map((run) => metric(run, ["moved_to_review_later"]))),
    batchReady: max(coverageRuns.map((run) => metric(run, ["queued_for_ai_review"]))),
    batchSubmitted: max(coverageRuns.map((run) => metric(run, ["submitted_to_gemini_batch"]))),
    awardsQueued: max(runs.map((run) => metric(run, ["awards_queued_for_reconciliation"]))),
    awardsReconciled: max(runs.map((run) => metric(run, ["awards_reconciled"]))),
    factsAdded: sum(runs.filter(isBaselineFactsRun).map((run) => Math.max(
      metric(run, ["applied"]),
      metric(run, ["extracted"]),
    ))),
  };
  return totals;
}

function currentItems(
  totals: Totals,
  options: { hasVisual: boolean; hasCoverage: boolean },
) {
  const items: RunReportItem[] = [];
  if (options.hasVisual) {
    items.push(item("checked", "Pages checked", totals.pagesChecked, "across the daily source scan", "positive"));
    items.push(item("candidates", "Change candidates", totals.candidates, "before verification", "neutral"));
    items.push(item("published", "Verified updates", totals.published, "safe to show publicly", "positive"));
  }
  if (totals.noiseRejected) {
    items.push(item("noise", "Noise dismissed", totals.noiseRejected, "stopped before AI review", "positive"));
  }
  if (totals.sectionsRead) {
    items.push(item("sections", "Sections read", totals.sectionsRead, "expandable panels extracted", "neutral"));
  }
  if (totals.failedLoads) {
    items.push(item("failures", "Load failures", totals.failedLoads, "pages to retry", "attention"));
  }
  if (options.hasCoverage) {
    items.push(item("excluded", "Sources excluded", totals.sourcesExcluded, "removed from daily monitoring", "positive"));
    items.push(item("batch-ready", "Batch review ready", totals.batchReady, "sources awaiting AI decisions", "neutral"));
  }
  return items.slice(0, 8);
}

function completedItems(totals: Totals) {
  const items: RunReportItem[] = [];
  if (totals.pagesChecked) items.push(item("checked", "Pages checked", totals.pagesChecked, "official source pages", "positive"));
  if (totals.candidates) items.push(item("candidates", "Candidates found", totals.candidates, "before verification", "neutral"));
  if (totals.published) items.push(item("published", "Updates published", totals.published, "verified applicant-facing changes", "positive"));
  if (totals.sourcesExcluded) items.push(item("excluded", "Sources excluded", totals.sourcesExcluded, "kept out of monitoring", "positive"));
  if (totals.factsAdded) items.push(item("facts", "AI facts added", totals.factsAdded, "evidence-backed interpretations", "positive"));
  if (totals.awardsReconciled) items.push(item("reconciled", "Awards rebuilt", totals.awardsReconciled, "reconciled public pages", "positive"));
  if (totals.failedLoads) items.push(item("failures", "Load failures", totals.failedLoads, "pages needing a retry", "attention"));
  return items;
}

function item(
  key: string,
  label: string,
  value: number,
  detail: string,
  tone: RunReportItem["tone"],
): RunReportItem {
  return { key, label, value, detail, tone };
}

function isVisualRun(run: WorkerRun) {
  return runKind(run) === "visual_snapshot" || /visual-snapshot-worker/i.test(run.worker_name);
}

function isDailyVisualRun(run: WorkerRun) {
  return isVisualRun(run) && /visual-snapshot-worker-shard-\d+-of-\d+$/i.test(run.worker_name);
}

function isScheduledDailyVisualRun(run: WorkerRun) {
  if (!isDailyVisualRun(run)) return false;
  const metadata = record(run.metadata);
  const identity = record(metadata.run_identity);
  const options = record(metadata.options);
  return isScheduledNightlyVisualRun({
    startedAt: run.started_at,
    runIdentity: identity,
    options,
  });
}

function isLegacyVisualRun(run: WorkerRun) {
  const metadata = record(run.metadata);
  const identity = record(metadata.run_identity);
  const options = record(metadata.options);
  return !cleanText(identity.trigger || options.run_trigger);
}

function visualShardIndex(run: WorkerRun) {
  const metadata = record(run.metadata);
  const identity = record(metadata.run_identity);
  const options = record(metadata.options);
  const metadataValue = numberOrNull(identity.shard_index ?? options.shard_index);
  if (metadataValue !== null && metadataValue >= 0) return Math.floor(metadataValue);
  const match = run.worker_name.match(/shard-(\d+)-of-(\d+)$/i);
  return match ? Math.max(0, Number(match[1]) - 1) : null;
}

function visualShardCount(run: WorkerRun) {
  const metadata = record(run.metadata);
  const identity = record(metadata.run_identity);
  const options = record(metadata.options);
  const metadataValue = numberOrNull(identity.shard_count ?? options.shard_count);
  if (metadataValue !== null && metadataValue > 0) return Math.floor(metadataValue);
  const match = run.worker_name.match(/shard-(\d+)-of-(\d+)$/i);
  return match ? Math.max(1, Number(match[2])) : 1;
}

function isAiCoverageRun(run: WorkerRun) {
  return runKind(run) === "open_source_ai_review_coverage_backfill" ||
    /open-source-ai-coverage-backfill/i.test(run.worker_name);
}

function isMaintenanceRun(run: WorkerRun) {
  return runKind(run) === "maintenance" || run.worker_name === "local-maintenance-runner";
}

function isBaselineFactsRun(run: WorkerRun) {
  return runKind(run) === "baseline_facts" || /baseline-facts-worker/i.test(run.worker_name);
}

function runKind(run: WorkerRun) {
  return cleanText(record(run.metadata).kind);
}

function runProfile(run: WorkerRun) {
  return cleanText(record(run.metadata).profile);
}

function metric(run: WorkerRun, keys: string[]) {
  const metadata = record(run.metadata);
  const containers = [
    metadata,
    record(metadata.counts),
    record(metadata.counters),
    record(metadata.final_summary),
  ];
  for (const key of keys) {
    for (const container of containers) {
      if (Object.prototype.hasOwnProperty.call(container, key)) {
        return numberValue(container[key]);
      }
    }
  }
  return 0;
}

function loadedSourcesForRun(run: WorkerRun) {
  const metadata = record(run.metadata);
  const baselineCoverage = record(metadata.baseline_coverage);
  const start = record(baselineCoverage.start);
  const loaded = numberValue(start.loaded_sources);
  return loaded || Math.max(numberValue(run.checked_count), numberValue(run.failed_count));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function numberOrNull(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + numberValue(value), 0);
}

function max(values: number[]) {
  return values.reduce((highest, value) => Math.max(highest, numberValue(value)), 0);
}

function earliestDate(values: string[]) {
  return [...values].sort((left, right) => dateMs(left) - dateMs(right))[0] || null;
}

function latestDate(values: Array<string | null>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => dateMs(right) - dateMs(left))[0] || null;
}

function dateMs(value: string | null | undefined) {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function monitoringWindowKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const local = new Date(Date.UTC(
    Number(byType.get("year")),
    Number(byType.get("month")) - 1,
    Number(byType.get("day")),
  ));
  if (Number(byType.get("hour")) < 18) local.setUTCDate(local.getUTCDate() - 1);
  return local.toISOString().slice(0, 10);
}

function withinSixPmLaunchGrace(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return Number(byType.get("hour")) === 18 && Number(byType.get("minute")) < 15;
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function plural(value: number, singular: string) {
  return value === 1 ? singular : `${singular}s`;
}

function joinSummaryParts(parts: string[]) {
  if (!parts.length) return "completed without recording measurable changes";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}
