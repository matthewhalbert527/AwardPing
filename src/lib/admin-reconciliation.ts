import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type AdminClient = SupabaseClient<Database>;
type LocalWorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

const reconciliationStatuses = ["pending", "processing", "succeeded", "failed", "skipped"] as const;
export type ReconciliationStatus = (typeof reconciliationStatuses)[number];

export type AwardReconciliationSummary = {
  configured: boolean;
  warning: string | null;
  queueCounts: Record<ReconciliationStatus, number>;
  pendingOrProcessing: number;
  latestRun: {
    id: string | null;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    reportPath: string | null;
    awardsChecked: number;
    awardsReconciled: number;
    awardsAuditPassed: number;
    awardsAuditWarnings: number;
    awardsAuditFailed: number;
    awardsPublicationBlocked: number;
    awardsUsedLastKnownGood: number;
    siblingSourcesRejected: number;
    deadlineConflictsDetected: number;
    staleCycleStatesCorrected: number;
    factsPublished: number;
    factsDryRun: number;
  } | null;
  latestFailures: Array<{
    id: string;
    awardId: string;
    reason: string;
    error: string | null;
    completedAt: string | null;
  }>;
};

export async function loadAwardReconciliationSummary(
  admin: AdminClient,
  workerRuns: LocalWorkerRun[] = [],
): Promise<{ summary: AwardReconciliationSummary; warnings: string[]; loadErrors: string[] }> {
  const rawAdmin = admin as unknown as SupabaseClient;
  const loadErrors: string[] = [];
  const warnings: string[] = [];
  const queueCounts = emptyQueueCounts();
  const countResults = await Promise.all(
    reconciliationStatuses.map(async (status) => {
      const result = await rawAdmin
        .from("shared_award_reconciliation_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", status);
      return { status, count: result.count || 0, error: result.error };
    }),
  );
  const missingError = countResults.find((result) => result.error && isMissingRelationError(result.error.message));
  if (missingError) {
    const warning = "Award reconciliation queue is not configured yet.";
    warnings.push(warning);
    return { summary: unavailableSummary(warning, workerRuns), warnings, loadErrors: [] };
  }
  for (const result of countResults) {
    if (result.error?.message) loadErrors.push(result.error.message);
    queueCounts[result.status] = result.count;
  }

  const failedResult = await rawAdmin
    .from("shared_award_reconciliation_queue")
    .select("id,shared_award_id,reason,error,completed_at")
    .eq("status", "failed")
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(10);
  if (failedResult.error?.message) {
    if (isMissingRelationError(failedResult.error.message)) {
      const warning = "Award reconciliation queue is not configured yet.";
      warnings.push(warning);
      return { summary: unavailableSummary(warning, workerRuns), warnings, loadErrors };
    }
    loadErrors.push(failedResult.error.message);
  }

  return {
    summary: {
      configured: true,
      warning: null,
      queueCounts,
      pendingOrProcessing: queueCounts.pending + queueCounts.processing,
      latestRun: latestReconciliationRun(workerRuns),
      latestFailures: ((failedResult.data || []) as Array<Record<string, unknown>>).map((row) => ({
        id: cleanText(row.id),
        awardId: cleanText(row.shared_award_id),
        reason: cleanText(row.reason),
        error: cleanText(row.error) || null,
        completedAt: cleanText(row.completed_at) || null,
      })),
    },
    warnings,
    loadErrors,
  };
}

export function summarizeAwardReconciliation(
  queueRows: Array<Record<string, unknown>>,
  workerRuns: LocalWorkerRun[] = [],
  warning: string | null = null,
): AwardReconciliationSummary {
  if (warning) return unavailableSummary(warning, workerRuns);
  const queueCounts = emptyQueueCounts();
  for (const row of queueRows) {
    const status = cleanReconciliationStatus(row.status);
    if (status) queueCounts[status] += 1;
  }
  return {
    configured: true,
    warning: null,
    queueCounts,
    pendingOrProcessing: queueCounts.pending + queueCounts.processing,
    latestRun: latestReconciliationRun(workerRuns),
    latestFailures: queueRows
      .filter((row) => cleanReconciliationStatus(row.status) === "failed")
      .slice(0, 10)
      .map((row) => ({
        id: cleanText(row.id),
        awardId: cleanText(row.shared_award_id),
        reason: cleanText(row.reason),
        error: cleanText(row.error) || null,
        completedAt: cleanText(row.completed_at) || null,
      })),
  };
}

export function latestReconciliationRun(workerRuns: LocalWorkerRun[]): AwardReconciliationSummary["latestRun"] {
  const run = (workerRuns || []).find((candidate) => {
    const metadata = objectValue(candidate.metadata);
    if (candidate.worker_name.includes("reconciliation")) return true;
    if (metadata.kind === "award_page_reconciliation") return true;
    if (metadata.kind === "maintenance") {
      return maintenancePhases(metadata).some((phase) => cleanText(phase.name) === "reconcile-awards");
    }
    return false;
  });
  if (!run) return null;
  const metadata = objectValue(run.metadata);
  const counts = objectValue(metadata.counts);
  const reconciliationWorker = objectValue(metadata.reconciliation_worker);
  return {
    id: run.id,
    status: cleanText(metadata.status) || run.status,
    startedAt: cleanText(run.started_at || metadata.started_at) || null,
    finishedAt: cleanText(run.finished_at || metadata.finished_at) || null,
    reportPath: cleanText(metadata.report_path || reconciliationWorker.report_path) || null,
    awardsChecked: numberFromAny(metadata.awards_checked, counts.awards_checked),
    awardsReconciled: numberFromAny(metadata.awards_reconciled, counts.awards_reconciled, reconciliationWorker.awards_reconciled),
    awardsAuditPassed: numberFromAny(metadata.awards_audit_passed, counts.awards_audit_passed),
    awardsAuditWarnings: numberFromAny(metadata.awards_audit_warnings, counts.awards_audit_warnings),
    awardsAuditFailed: numberFromAny(metadata.awards_audit_failed, counts.awards_audit_failed),
    awardsPublicationBlocked: numberFromAny(metadata.awards_publication_blocked, counts.awards_publication_blocked, metadata.public_pages_blocked),
    awardsUsedLastKnownGood: numberFromAny(metadata.awards_used_last_known_good, counts.awards_used_last_known_good, metadata.last_known_good_preserved),
    siblingSourcesRejected: numberFromAny(metadata.sibling_sources_rejected, counts.sibling_sources_rejected),
    deadlineConflictsDetected: numberFromAny(metadata.deadline_conflicts_detected, counts.deadline_conflicts_detected),
    staleCycleStatesCorrected: numberFromAny(metadata.stale_cycle_states_corrected, counts.stale_cycle_states_corrected),
    factsPublished: numberFromAny(metadata.facts_published, counts.facts_published),
    factsDryRun: numberFromAny(metadata.facts_dry_run, counts.facts_dry_run),
  };
}

function unavailableSummary(warning: string, workerRuns: LocalWorkerRun[]): AwardReconciliationSummary {
  return {
    configured: false,
    warning,
    queueCounts: emptyQueueCounts(),
    pendingOrProcessing: 0,
    latestRun: latestReconciliationRun(workerRuns),
    latestFailures: [],
  };
}

function emptyQueueCounts() {
  return Object.fromEntries(reconciliationStatuses.map((status) => [status, 0])) as Record<ReconciliationStatus, number>;
}

function cleanReconciliationStatus(value: unknown): ReconciliationStatus | null {
  const status = cleanText(value);
  return reconciliationStatuses.includes(status as ReconciliationStatus) ? (status as ReconciliationStatus) : null;
}

function maintenancePhases(metadata: Record<string, unknown>) {
  return (Array.isArray(metadata.phases) ? metadata.phases : []).map((phase) => objectValue(phase));
}

function numberFromAny(...values: unknown[]) {
  for (const value of values) {
    const number = nullableNumber(value);
    if (number !== null) return number;
  }
  return 0;
}

function nullableNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isMissingRelationError(message: string) {
  return /schema cache|does not exist|could not find the table|could not find.*column|column .* does not exist|42P01|42703|PGRST/i.test(
    message,
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
