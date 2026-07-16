import type { Database } from "@/lib/database.types";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type LocalWorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];
type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export const scheduledVisualRecoveryWorkerNames = [
  "local-visual-snapshot-worker-shard-1-of-3",
  "local-visual-snapshot-worker-shard-2-of-3",
  "local-visual-snapshot-worker-shard-3-of-3",
] as const;

export type AdminGeminiBudgetLane = {
  laneKey: string;
  label: string;
  capUsd: number;
  reservedUsd: number;
  spentUsd: number;
  remainingUsd: number;
  resetAt: string | null;
  configurationSource: string;
};

export type AdminDownstreamLane = {
  laneKey: string;
  label: string;
  paid: boolean;
  enabled: boolean;
  claimable: boolean;
  timeoutSeconds: number;
  leaseTtlSeconds: number;
  oldestItemSlaSeconds: number;
  queueDepth: number;
  oldestItemAt: string | null;
  nextSlaDueAt: string | null;
  slaBreached: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  leaseExpired: boolean;
  nextRetryAt: string | null;
  consecutiveFailures: number;
  lastStatus: string | null;
  lastError: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  policySource: string;
};

export type AdminEvidenceRecoveryStatus = {
  enabled: boolean | null;
  expectedShards: number;
  reportingShards: number;
  missingShardNumbers: number[];
  disabledShardNumbers: number[];
  unknownShardNumbers: number[];
  attempts: number;
  recovered: number;
  exactGeometryRecovered: number;
  evidenceOnlyRecovered: number;
  refused: number;
  failed: number;
  reasons: Array<{ code: string; count: number }>;
  statusReason: string;
  safeAction: string;
  lastReportedAt: string | null;
  configurationSource: string;
};

export type AdminWorkerOperations = {
  budgets: AdminGeminiBudgetLane[];
  lanes: AdminDownstreamLane[];
  evidenceRecovery: AdminEvidenceRecoveryStatus;
  recoveryLoadErrors: string[];
  operationsLoadErrors: string[];
  loadErrors: string[];
};

export function downstreamLaneRuntimeState(
  lane: AdminDownstreamLane,
  now: Date | string,
) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const oldestItemMs = timestampMs(lane.oldestItemAt);
  const leaseExpiresMs = timestampMs(lane.leaseExpiresAt);
  const nextRetryMs = timestampMs(lane.nextRetryAt);
  const oldestItemOverdue = Number.isFinite(nowMs) && oldestItemMs !== null &&
    lane.oldestItemSlaSeconds > 0 &&
    nowMs - oldestItemMs > lane.oldestItemSlaSeconds * 1_000;
  const expiredLease = lane.leaseExpired || (
    lane.lastStatus === "claimed" &&
    Number.isFinite(nowMs) &&
    leaseExpiresMs !== null &&
    leaseExpiresMs <= nowMs
  );
  const retryDue = Number.isFinite(nowMs) && nextRetryMs !== null && nextRetryMs <= nowMs;
  const retryWaiting = lane.enabled && !expiredLease &&
    Number.isFinite(nowMs) && nextRetryMs !== null && nextRetryMs > nowMs;
  const overdue = lane.slaBreached || oldestItemOverdue;
  const overdueUnclaimed = lane.enabled && lane.claimable && (
    overdue || (retryDue && lane.consecutiveFailures > 0)
  );

  return {
    disabled: !lane.enabled,
    expiredLease,
    oldestItemOverdue,
    overdue,
    overdueUnclaimed,
    retryDue,
    retryWaiting,
  };
}

export async function loadAdminWorkerOperations(
  admin: AdminClient,
  workerRuns: LocalWorkerRun[],
  existingLoadErrors: string[] = [],
  now = new Date(),
): Promise<AdminWorkerOperations> {
  const [budgetResult, laneResult] = await Promise.all([
    admin.rpc("list_gemini_budget_status"),
    admin.rpc("list_monitoring_downstream_lane_status"),
  ]);
  const operationsLoadErrors = [budgetResult.error?.message, laneResult.error?.message].filter(
    (message): message is string => Boolean(message),
  );
  return {
    budgets: rowsOf(budgetResult.data).map(normalizeBudgetLane),
    lanes: rowsOf(laneResult.data).map(normalizeDownstreamLane),
    evidenceRecovery: evidenceRecoveryFromRuns(workerRuns, now),
    recoveryLoadErrors: existingLoadErrors,
    operationsLoadErrors,
    loadErrors: [...existingLoadErrors, ...operationsLoadErrors],
  };
}

function evidenceRecoveryFromRuns(workerRuns: LocalWorkerRun[], now: Date): AdminEvidenceRecoveryStatus {
  const expectedShards = 3;
  const expectedMonitoringDate = monitoringDateForTimestamp(now);
  const expectedCohort = `visual-nightly:${expectedMonitoringDate}`;
  const scheduledRuns = workerRuns
    .map((run) => ({ run, identity: visualRunIdentity(run) }))
    .filter((entry): entry is ScheduledVisualRun => Boolean(entry.identity))
    .filter((entry) => entry.identity.cohortKey === expectedCohort)
    .sort((left, right) => runTimestamp(right.run) - runTimestamp(left.run));
  const latestByShard = new Map<number, LocalWorkerRun>();
  for (const entry of scheduledRuns) {
    if (latestByShard.has(entry.identity.shardIndex)) continue;
    latestByShard.set(entry.identity.shardIndex, entry.run);
  }
  const runs = [...latestByShard.values()];
  const metadata = runs.map((run) => objectValue(run.metadata));
  const shardSettings = new Map<number, boolean | null>();
  for (const [shardIndex, run] of latestByShard) {
    const value = objectValue(run.metadata);
    const options = objectValue(value.options);
    const setting = firstPresentValue(
      [options, "r2_rehydrate_local_cache"],
      [value, "r2_local_cache_rehydration_enabled"],
      [options, "r2_snapshot_sync"],
      [value, "r2_snapshot_sync"],
    );
    shardSettings.set(shardIndex, typeof setting === "boolean" ? setting : null);
  }
  const missingShardNumbers = range(expectedShards)
    .filter((shardIndex) => !latestByShard.has(shardIndex))
    .map((shardIndex) => shardIndex + 1);
  const disabledShardNumbers = [...shardSettings]
    .filter(([, enabled]) => enabled === false)
    .map(([shardIndex]) => shardIndex + 1)
    .sort(numberAscending);
  const unknownShardNumbers = [...shardSettings]
    .filter(([, enabled]) => enabled === null)
    .map(([shardIndex]) => shardIndex + 1)
    .sort(numberAscending);
  const allShardsReported = latestByShard.size === expectedShards;
  const allSettingsReported = shardSettings.size === expectedShards && unknownShardNumbers.length === 0;
  const enabled = allShardsReported && allSettingsReported
    ? disabledShardNumbers.length === 0
    : null;
  const counts = metadata.map((value) => objectValue(value.counts));
  const attempts = sumFields(counts, "r2_rehydrate_local_cache", "r2_local_cache_rehydration_attempted");
  const recovered = sumFields(counts, "r2_rehydrated_local", "r2_local_cache_rehydrated");
  const exactGeometryRecovered = sumFields(counts, "r2_rehydrated_local_exact_geometry");
  const evidenceOnlyRecovered = sumFields(counts, "r2_rehydrated_local_evidence_only");
  const refused = sumFields(counts, "r2_rehydration_refused", "r2_local_cache_rehydration_refused");
  const failed = sumFields(counts, "r2_rehydration_failed", "r2_local_cache_rehydration_failed");
  const reasons = recoveryReasons(counts);
  return {
    enabled,
    expectedShards,
    reportingShards: latestByShard.size,
    missingShardNumbers,
    disabledShardNumbers,
    unknownShardNumbers,
    attempts,
    recovered,
    exactGeometryRecovered,
    evidenceOnlyRecovered,
    refused,
    failed,
    reasons,
    statusReason: recoveryStatusReason({
      enabled,
      expectedShards,
      reportingShards: latestByShard.size,
      missingShardNumbers,
      disabledShardNumbers,
      unknownShardNumbers,
      refused,
      failed,
    }),
    safeAction: recoverySafeAction({
      enabled,
      missingShardNumbers,
      disabledShardNumbers,
      unknownShardNumbers,
      refused,
      failed,
    }),
    lastReportedAt: runs
      .map((run) => run.finished_at || run.started_at)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
    configurationSource: `Immutable R2 generation + current scheduled cohort ${expectedCohort}`,
  };
}

function normalizeBudgetLane(value: unknown): AdminGeminiBudgetLane {
  const row = objectValue(value);
  const laneKey = text(row.lane_key);
  return {
    laneKey,
    label: laneKey === "new_page_review" ? "New page review" : "Changed page review",
    capUsd: money(row.cap_usd, row.cap_micro_usd),
    reservedUsd: money(row.reserved_usd, row.reserved_micro_usd),
    spentUsd: money(row.spent_usd, row.spent_micro_usd),
    remainingUsd: money(row.remaining_usd, row.remaining_micro_usd),
    resetAt: nullableText(row.reset_at),
    configurationSource: text(row.configuration_source ?? row.source) || "Database policy: fixed $5 UTC-day cap",
  };
}

function normalizeDownstreamLane(value: unknown): AdminDownstreamLane {
  const row = objectValue(value);
  const laneKey = text(row.lane_key);
  return {
    laneKey,
    label: text(row.display_name) || laneKey.replaceAll("_", " "),
    paid: Boolean(row.paid ?? row.is_paid ?? row.creates_api_charge),
    enabled: row.enabled !== false,
    claimable: row.claimable === true,
    timeoutSeconds: integer(row.timeout_seconds ?? row.lease_ttl_seconds),
    leaseTtlSeconds: integer(row.lease_ttl_seconds),
    oldestItemSlaSeconds: integer(
      row.oldest_item_sla_seconds === undefined ? row.sla_seconds : row.oldest_item_sla_seconds,
    ),
    queueDepth: integer(row.queue_depth),
    oldestItemAt: nullableText(row.oldest_item_at),
    nextSlaDueAt: nullableText(row.next_sla_due_at ?? row.sla_deadline),
    slaBreached: Boolean(row.sla_breached),
    leaseOwner: nullableText(row.lease_owner),
    leaseExpiresAt: nullableText(row.lease_expires_at),
    leaseExpired: row.lease_expired === true,
    nextRetryAt: nullableText(row.next_retry_at ?? row.next_eligible_at),
    consecutiveFailures: integer(row.consecutive_failures),
    lastStatus: nullableText(row.last_status ?? row.status),
    lastError: nullableText(row.last_error),
    lastStartedAt: nullableText(row.last_started_at),
    lastFinishedAt: nullableText(row.last_finished_at),
    lastSucceededAt: nullableText(row.last_succeeded_at),
    lastFailedAt: nullableText(row.last_failed_at),
    policySource: text(row.source) || "postgres_lane_scheduler_v1",
  };
}

type VisualRunIdentity = {
  cohortKey: string;
  shardIndex: number;
};

type ScheduledVisualRun = {
  run: LocalWorkerRun;
  identity: VisualRunIdentity;
};

function visualRunIdentity(run: LocalWorkerRun): VisualRunIdentity | null {
  const metadata = objectValue(run.metadata);
  if (text(metadata.kind) !== "visual_snapshot") return null;
  const identity = objectValue(metadata.run_identity);
  if (text(identity.trigger) !== "scheduled" || integer(identity.shard_count) !== 3) return null;
  const shardIndex = nonNegativeInteger(identity.shard_index);
  if (shardIndex === null || shardIndex >= 3) return null;
  const expectedWorkerName = scheduledVisualRecoveryWorkerNames[shardIndex];
  if (run.worker_name !== expectedWorkerName) return null;
  const cohortKey = text(identity.cohort_id) || text(identity.monitoring_date);
  return cohortKey ? { cohortKey, shardIndex } : null;
}

function recoveryReasons(rows: Record<string, unknown>[]) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const reasons = objectValue(row.r2_rehydration_reasons ?? row.r2_local_cache_rehydration_reasons);
    for (const [code, value] of Object.entries(reasons)) {
      const count = integer(value);
      if (!code.trim() || count <= 0) continue;
      totals.set(code, (totals.get(code) || 0) + count);
    }
  }
  return [...totals]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

function recoveryStatusReason(input: Pick<AdminEvidenceRecoveryStatus,
  "enabled" | "expectedShards" | "reportingShards" | "missingShardNumbers" | "disabledShardNumbers" |
  "unknownShardNumbers" | "refused" | "failed"
>) {
  if (input.missingShardNumbers.length > 0) {
    return `Scheduled ${shardList(input.missingShardNumbers)} did not report in the current 6 PM cohort.`;
  }
  if (input.unknownShardNumbers.length > 0) {
    return `${shardList(input.unknownShardNumbers)} did not report whether verified R2 recovery was enabled.`;
  }
  if (input.disabledShardNumbers.length > 0 || input.enabled === false) {
    return `Verified R2 recovery is disabled on ${shardList(input.disabledShardNumbers)}.`;
  }
  if (input.failed > 0 || input.refused > 0) {
    return `All ${input.expectedShards} scheduled shards are configured, but the current cohort reported ${input.failed} failure${input.failed === 1 ? "" : "s"} and ${input.refused} refused restore${input.refused === 1 ? "" : "s"}.`;
  }
  if (input.enabled === true) {
    return `All ${input.expectedShards} scheduled shards reported verified R2 recovery enabled.`;
  }
  return `${input.reportingShards} of ${input.expectedShards} scheduled shards reported; recovery readiness is not yet verified.`;
}

function recoverySafeAction(input: Pick<AdminEvidenceRecoveryStatus,
  "enabled" | "missingShardNumbers" | "disabledShardNumbers" | "unknownShardNumbers" | "refused" | "failed"
>) {
  if (input.missingShardNumbers.length > 0) {
    return `Check the Scheduled Task and wrapper log for ${shardList(input.missingShardNumbers)}, then rerun only the missing shard. Do not replace a local baseline by hand.`;
  }
  if (input.unknownShardNumbers.length > 0) {
    return `Verify AWARDPING_R2_SNAPSHOT_SYNC=true for ${shardList(input.unknownShardNumbers)}, then rerun only that shard so it reports the setting.`;
  }
  if (input.disabledShardNumbers.length > 0 || input.enabled === false) {
    return `Set AWARDPING_R2_SNAPSHOT_SYNC=true for ${shardList(input.disabledShardNumbers)}, then rerun only the disabled shard.`;
  }
  if (input.failed > 0) {
    return "Verify R2 credentials and connectivity, then retry the affected item. Keep the last-known-good local baseline in place.";
  }
  if (input.refused > 0) {
    return "Inspect the reported immutable-object, metadata, and hash mismatch. Do not force the restore or overwrite the local baseline.";
  }
  return "No operator action is required. Continue verifying this status on each scheduled 6 PM cohort.";
}

function shardList(shards: number[]) {
  if (shards.length === 0) return "the affected shard";
  return `${shards.length === 1 ? "shard" : "shards"} ${shards.join(", ")}`;
}

function range(length: number) {
  return Array.from({ length }, (_, index) => index);
}

function numberAscending(left: number, right: number) {
  return left - right;
}

function runTimestamp(run: LocalWorkerRun) {
  const parsed = Date.parse(run.finished_at || run.started_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function monitoringDateForTimestamp(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const localDate = new Date(Date.UTC(
    Number(byType.get("year")),
    Number(byType.get("month")) - 1,
    Number(byType.get("day")),
  ));
  if (Number(byType.get("hour")) < 18) localDate.setUTCDate(localDate.getUTCDate() - 1);
  return localDate.toISOString().slice(0, 10);
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function firstPresentValue(...candidates: Array<[Record<string, unknown>, string]>) {
  for (const [object, key] of candidates) {
    if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
  }
  return undefined;
}

function rowsOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function sumFields(rows: Record<string, unknown>[], ...keys: string[]) {
  return rows.reduce((sum, row) => {
    const value = keys.map((key) => Number(row[key])).find(Number.isFinite) || 0;
    return sum + Math.max(0, Math.floor(value));
  }, 0);
}

function money(usd: unknown, microUsd: unknown) {
  const direct = Number(usd);
  if (Number.isFinite(direct)) return direct;
  const micro = Number(microUsd);
  return Number.isFinite(micro) ? micro / 1_000_000 : 0;
}

function integer(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown) {
  return text(value) || null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function timestampMs(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
