import type { Json } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export type AdminManualQuarantineClassification =
  "actionable_quarantine" | "historical_limitation";

export type AdminManualQuarantineCategory =
  "public_page" | "visual_review" | "historical_localization";

export type AdminManualQuarantineCategorySummary = {
  cases: number;
  evidenceRecords: number;
  terminalCases: number;
  terminalFailures: number;
  oldestObservedAt: string | null;
  unknownPublicImpactCases: number;
};

export type AdminManualQuarantineItem = {
  id: string;
  quarantineKey: string;
  caseKey: string;
  classification: AdminManualQuarantineClassification;
  category: AdminManualQuarantineCategory;
  status: "quarantined" | "in_review" | "resolved";
  requiresAction: boolean;
  terminal: boolean;
  terminalFailureCount: number;
  severity: "high" | "medium" | "low";
  publicImpact: "blocked" | "delayed" | "protected" | "none" | "unknown";
  owner: string;
  retryMode: string;
  retryCharge: "none" | "will_charge" | "may_charge" | "unknown";
  title: string;
  reasonCode: string;
  reason: string;
  recommendedAction: string;
  awardId: string | null;
  sourceId: string | null;
  visualCandidateId: string | null;
  primarySourceTable: string;
  primarySourceRecordId: string;
  evidenceRecordCount: number;
  evidence: Json;
  evidenceHash: string;
  policyId: string;
  policyVersion: string;
  policyHash: string;
  firstObservedAt: string;
  lastObservedAt: string;
  quarantinedAt: string;
  updatedAt: string;
};

export type AdminManualQuarantineSummary = {
  automatedWorkClear: boolean | null;
  automatedBlockers: Json;
  quarantinedWorkRemaining: number;
  quarantineEvidenceRecords: number;
  historicalLimitations: number | null;
  historicalInventoryStatus: "not_imported" | "complete";
  terminalFailuresRequiringAction: number;
  byCategory: Record<
    AdminManualQuarantineCategory,
    AdminManualQuarantineCategorySummary
  >;
  completionStatus:
    "not_reported" | "automated_work_remaining" | "automated_work_clear";
  sourceWorkerRunId: string | null;
  completionReportedAt: string | null;
  historicalInventoryReportedAt: string | null;
  historicalInventoryDigest: string | null;
  lastSyncedAt: string | null;
};

export type AdminManualQuarantineLoadResult = {
  summary: AdminManualQuarantineSummary;
  items: AdminManualQuarantineItem[];
  total: number;
  registryAvailable: boolean;
  loadErrors: string[];
};

type ManualQuarantineRegistryRow = {
  id: string;
  quarantine_key: string;
  case_key: string;
  classification: string;
  category: string;
  status: string;
  requires_action: boolean;
  terminal: boolean;
  terminal_failure_count: number;
  severity: string;
  public_impact: string;
  owner: string;
  retry_mode: string;
  retry_charge: string;
  title: string;
  reason_code: string;
  reason: string;
  recommended_action: string;
  shared_award_id: string | null;
  shared_award_source_id: string | null;
  visual_review_candidate_id: string | null;
  primary_source_table: string;
  primary_source_record_id: string;
  evidence_record_count: number;
  evidence: Json;
  evidence_hash: string;
  policy_id: string;
  policy_version: string;
  policy_hash: string;
  first_observed_at: string;
  last_observed_at: string;
  quarantined_at: string;
  updated_at: string;
};

type ManualQuarantineStateRow = {
  automated_work_clear: boolean | null;
  automated_blockers: Json;
  quarantined_work_remaining: number;
  quarantine_evidence_records: number;
  historical_limitations: number | null;
  historical_inventory_status: string;
  terminal_failures_requiring_action: number;
  by_category: Json;
  completion_status: string;
  source_worker_run_id: string | null;
  completion_reported_at: string | null;
  historical_inventory_reported_at: string | null;
  historical_inventory_digest: string | null;
  last_synced_at: string;
};

const ITEM_PAGE_SIZE = 1_000;
const DEFAULT_FRESHNESS_WINDOW_MS = 2 * 60 * 60 * 1_000;

type AdminManualQuarantineLoadOptions = {
  now?: Date;
  freshnessWindowMs?: number;
};

export async function loadAdminManualQuarantine(
  admin: AdminClient,
  options: AdminManualQuarantineLoadOptions = {},
): Promise<AdminManualQuarantineLoadResult> {
  const [stateResult, itemsResult] = await Promise.all([
    admin
      .from("manual_quarantine_registry_state")
      .select(
        "automated_work_clear, automated_blockers, quarantined_work_remaining, quarantine_evidence_records, historical_limitations, historical_inventory_status, terminal_failures_requiring_action, by_category, completion_status, source_worker_run_id, completion_reported_at, historical_inventory_reported_at, historical_inventory_digest, last_synced_at",
      )
      .eq("registry_key", "one_time_catchup")
      .maybeSingle(),
    loadAllActionableQuarantineRows(admin),
  ]);

  const missingRegistry = [
    stateResult.error?.message,
    itemsResult.error?.message,
  ]
    .filter((message): message is string => Boolean(message))
    .some(isMissingRegistryError);
  if (missingRegistry) {
    return {
      summary: emptyManualQuarantineSummary(),
      items: [],
      total: 0,
      registryAvailable: false,
      loadErrors: [
        "Manual Quarantine is not migrated for this deployment yet. Existing repair queues remain available in the Action Inbox.",
      ],
    };
  }

  const queryErrors = [
    stateResult.error?.message,
    itemsResult.error?.message,
  ].filter((message): message is string => Boolean(message));
  if (queryErrors.length > 0 || !stateResult.data) {
    return unavailableManualQuarantineResult(
      queryErrors.length > 0
        ? `Manual Quarantine could not be loaded authoritatively: ${queryErrors.join(" ")}`
        : "Manual Quarantine has no authoritative state row yet.",
    );
  }

  const stateRow = stateResult.data as ManualQuarantineStateRow;
  const nowMs = (options.now || new Date()).getTime();
  const lastSyncedMs = Date.parse(stateRow.last_synced_at || "");
  const freshnessWindowMs = Math.max(
    1,
    Number(options.freshnessWindowMs) || DEFAULT_FRESHNESS_WINDOW_MS,
  );
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(lastSyncedMs) ||
    Math.max(0, nowMs - lastSyncedMs) > freshnessWindowMs
  ) {
    return unavailableManualQuarantineResult(
      "Manual Quarantine is stale, so current page-audit and reconciliation queues remain authoritative in the Action Inbox until the next zero-charge sync.",
    );
  }

  const rows = (itemsResult.data || []) as ManualQuarantineRegistryRow[];
  const total = Number(itemsResult.count || rows.length);
  const loadErrors: string[] = [];
  const summary = mapManualQuarantineSummary(stateRow);
  if (total !== summary.quarantinedWorkRemaining) {
    return unavailableManualQuarantineResult(
      `Manual Quarantine changed while it was loading (${formatNumber(total)} actionable rows versus ${formatNumber(summary.quarantinedWorkRemaining)} state cases).`,
    );
  }

  return {
    summary,
    items: rows.map(mapManualQuarantineItem),
    total,
    registryAvailable: true,
    loadErrors,
  };
}

async function loadAllActionableQuarantineRows(admin: AdminClient) {
  const rows: ManualQuarantineRegistryRow[] = [];
  let expectedCount: number | null = null;

  for (let start = 0; ; start += ITEM_PAGE_SIZE) {
    const pageResult = await admin
      .from("manual_quarantine_registry")
      .select("*", { count: "exact" })
      .eq("requires_action", true)
      .in("status", ["quarantined", "in_review"])
      .order("terminal", { ascending: false })
      .order("first_observed_at", { ascending: true })
      .order("id", { ascending: true })
      .range(start, start + ITEM_PAGE_SIZE - 1);
    if (pageResult.error) {
      return { data: null, error: pageResult.error, count: expectedCount };
    }

    const page = (pageResult.data || []) as ManualQuarantineRegistryRow[];
    const pageCount = Number(pageResult.count || 0);
    if (expectedCount === null) expectedCount = pageCount;
    if (pageCount !== expectedCount) {
      return {
        data: null,
        error: { message: "Manual quarantine rows changed during paginated loading." },
        count: pageCount,
      };
    }
    rows.push(...page);
    if (rows.length >= expectedCount || page.length < ITEM_PAGE_SIZE) break;
  }

  const uniqueRows = [...new Map(rows.map((row) => [row.id, row])).values()];
  if (uniqueRows.length !== expectedCount) {
    return {
      data: null,
      error: { message: "Manual quarantine pagination did not return every actionable case." },
      count: expectedCount,
    };
  }
  return { data: uniqueRows, error: null, count: expectedCount };
}

function unavailableManualQuarantineResult(
  message: string,
): AdminManualQuarantineLoadResult {
  return {
    summary: emptyManualQuarantineSummary(),
    items: [],
    total: 0,
    registryAvailable: false,
    loadErrors: [
      `${message} Existing repair queues remain available; unavailable registry counts are not reported as zero.`,
    ],
  };
}

export function mapManualQuarantineItem(
  row: ManualQuarantineRegistryRow,
): AdminManualQuarantineItem {
  return {
    id: row.id,
    quarantineKey: row.quarantine_key,
    caseKey: row.case_key,
    classification: quarantineClassification(row.classification),
    category: quarantineCategory(row.category),
    status: quarantineStatus(row.status),
    requiresAction: row.requires_action,
    terminal: row.terminal,
    terminalFailureCount: Number(row.terminal_failure_count || 0),
    severity: severity(row.severity),
    publicImpact: publicImpact(row.public_impact),
    owner: row.owner,
    retryMode: row.retry_mode,
    retryCharge: retryCharge(row.retry_charge),
    title: row.title,
    reasonCode: row.reason_code,
    reason: row.reason,
    recommendedAction: row.recommended_action,
    awardId: row.shared_award_id,
    sourceId: row.shared_award_source_id,
    visualCandidateId: row.visual_review_candidate_id,
    primarySourceTable: row.primary_source_table,
    primarySourceRecordId: row.primary_source_record_id,
    evidenceRecordCount: Number(row.evidence_record_count || 1),
    evidence: row.evidence,
    evidenceHash: row.evidence_hash,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    policyHash: row.policy_hash,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    quarantinedAt: row.quarantined_at,
    updatedAt: row.updated_at,
  };
}

export function mapManualQuarantineSummary(
  row: ManualQuarantineStateRow,
): AdminManualQuarantineSummary {
  return {
    automatedWorkClear: row.automated_work_clear,
    automatedBlockers: row.automated_blockers,
    quarantinedWorkRemaining: Number(row.quarantined_work_remaining || 0),
    quarantineEvidenceRecords: Number(row.quarantine_evidence_records || 0),
    historicalLimitations:
      row.historical_inventory_status === "complete"
        ? Number(row.historical_limitations || 0)
        : null,
    historicalInventoryStatus:
      row.historical_inventory_status === "complete"
        ? "complete"
        : "not_imported",
    terminalFailuresRequiringAction: Number(
      row.terminal_failures_requiring_action || 0,
    ),
    byCategory: mapCategorySummaries(row.by_category),
    completionStatus: completionStatus(row.completion_status),
    sourceWorkerRunId: row.source_worker_run_id,
    completionReportedAt: row.completion_reported_at,
    historicalInventoryReportedAt: row.historical_inventory_reported_at,
    historicalInventoryDigest: row.historical_inventory_digest,
    lastSyncedAt: row.last_synced_at,
  };
}

export function emptyManualQuarantineSummary(): AdminManualQuarantineSummary {
  return {
    automatedWorkClear: null,
    automatedBlockers: {},
    quarantinedWorkRemaining: 0,
    quarantineEvidenceRecords: 0,
    historicalLimitations: null,
    historicalInventoryStatus: "not_imported",
    terminalFailuresRequiringAction: 0,
    byCategory: {
      public_page: emptyCategorySummary(),
      visual_review: emptyCategorySummary(),
      historical_localization: emptyCategorySummary(),
    },
    completionStatus: "not_reported",
    sourceWorkerRunId: null,
    completionReportedAt: null,
    historicalInventoryReportedAt: null,
    historicalInventoryDigest: null,
    lastSyncedAt: null,
  };
}

function mapCategorySummaries(
  value: Json,
): AdminManualQuarantineSummary["byCategory"] {
  const object = jsonObject(value);
  return {
    public_page: mapCategorySummary(object?.public_page),
    visual_review: mapCategorySummary(object?.visual_review),
    historical_localization: mapCategorySummary(
      object?.historical_localization,
    ),
  };
}

function mapCategorySummary(value: Json | undefined) {
  const object = jsonObject(value);
  return {
    cases: jsonNumber(object?.cases),
    evidenceRecords: jsonNumber(object?.evidence_records),
    terminalCases: jsonNumber(object?.terminal_cases),
    terminalFailures: jsonNumber(object?.terminal_failures),
    oldestObservedAt: jsonText(object?.oldest_observed_at),
    unknownPublicImpactCases: jsonNumber(object?.unknown_public_impact_cases),
  } satisfies AdminManualQuarantineCategorySummary;
}

function emptyCategorySummary(): AdminManualQuarantineCategorySummary {
  return {
    cases: 0,
    evidenceRecords: 0,
    terminalCases: 0,
    terminalFailures: 0,
    oldestObservedAt: null,
    unknownPublicImpactCases: 0,
  };
}

function jsonObject(value: Json | undefined | null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { [key: string]: Json | undefined })
    : null;
}

function jsonNumber(value: Json | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function jsonText(value: Json | undefined) {
  return typeof value === "string" && value.trim() ? value : null;
}

function quarantineClassification(
  value: string,
): AdminManualQuarantineClassification {
  return value === "historical_limitation"
    ? "historical_limitation"
    : "actionable_quarantine";
}

function quarantineCategory(value: string): AdminManualQuarantineCategory {
  if (value === "visual_review" || value === "historical_localization")
    return value;
  return "public_page";
}

function quarantineStatus(value: string): AdminManualQuarantineItem["status"] {
  if (value === "in_review" || value === "resolved") return value;
  return "quarantined";
}

function severity(value: string): AdminManualQuarantineItem["severity"] {
  if (value === "medium" || value === "low") return value;
  return "high";
}

function publicImpact(
  value: string,
): AdminManualQuarantineItem["publicImpact"] {
  if (
    value === "blocked" ||
    value === "delayed" ||
    value === "protected" ||
    value === "none"
  ) {
    return value;
  }
  return "unknown";
}

function retryCharge(value: string): AdminManualQuarantineItem["retryCharge"] {
  if (value === "none" || value === "will_charge" || value === "may_charge") {
    return value;
  }
  return "unknown";
}

function completionStatus(
  value: string,
): AdminManualQuarantineSummary["completionStatus"] {
  if (
    value === "automated_work_clear" ||
    value === "automated_work_remaining"
  ) {
    return value;
  }
  return "not_reported";
}

function isMissingRegistryError(message: string) {
  return /manual_quarantine_registry|manual_quarantine_registry_state|schema cache|PGRST205|42P01/i.test(
    message,
  );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
