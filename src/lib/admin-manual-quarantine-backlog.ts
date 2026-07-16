import { z } from "zod";
import { dashboardAwardPath } from "@/lib/award-slugs";
import type { Json } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export const manualQuarantineGroupByValues = [
  "repair_group",
  "domain",
  "evidence_failure",
  "policy_reason",
  "likely_repair",
] as const;
export const manualQuarantineSortValues = [
  "oldest",
  "newest",
  "priority",
  "domain",
] as const;
export const manualQuarantineAgeValues = [
  "under_24h",
  "one_to_three_days",
  "four_to_seven_days",
  "eight_to_thirty_days",
  "over_thirty_days",
] as const;
export const manualQuarantineStatusValues = [
  "quarantined",
  "in_review",
] as const;

export type AdminManualQuarantineGroupBy =
  (typeof manualQuarantineGroupByValues)[number];
export type AdminManualQuarantineSort =
  (typeof manualQuarantineSortValues)[number];
export type AdminManualQuarantineAge =
  (typeof manualQuarantineAgeValues)[number];
export type AdminManualQuarantineStatus =
  (typeof manualQuarantineStatusValues)[number];

export type AdminManualQuarantineBacklogFilters = {
  domains: string[];
  evidenceFailures: string[];
  policyReasons: string[];
  repairs: string[];
  owners: string[];
  statuses: AdminManualQuarantineStatus[];
  ageBucket: AdminManualQuarantineAge | null;
  search: string;
};

export type AdminManualQuarantineBacklogQuery =
  AdminManualQuarantineBacklogFilters & {
    page: number;
    pageSize: number;
    clusterPage: number;
    clusterPageSize: number;
    groupBy: AdminManualQuarantineGroupBy;
    sort: AdminManualQuarantineSort;
    activeViewId: string | null;
    snapshotAt: string | null;
    snapshotRevision: number | null;
    asOfAt: string | null;
  };

export type AdminManualQuarantineBacklogFacet = {
  key: string;
  label: string;
  cases: number;
};

export type AdminManualQuarantineBacklogCluster = {
  key: string;
  label: string;
  cases: number;
  evidenceRecords: number;
  terminalCases: number;
  unassignedCases: number;
  chargeGatedCases: number;
  oldestObservedAt: string | null;
  sourceDomain: string;
  evidenceFailureCode: string;
  evidenceFailureLabel: string;
  policyReasonCode: string;
  policyReasonLabel: string;
  likelyRepairCode: string;
  likelyRepairLabel: string;
};

export type AdminManualQuarantineBacklogItem = {
  id: string;
  quarantineKey: string;
  caseKey: string;
  category: "public_page" | "visual_review";
  status: AdminManualQuarantineStatus;
  terminal: boolean;
  terminalFailureCount: number;
  severity: "high" | "medium" | "low";
  publicImpact: "blocked" | "delayed" | "protected" | "none" | "unknown";
  functionalOwner: string;
  assignedToUserId: string | null;
  assignedToEmail: string | null;
  assignedAt: string | null;
  retryMode: string;
  retryCharge: "none" | "will_charge" | "may_charge" | "unknown";
  title: string;
  reasonCode: string;
  reason: string;
  recommendedAction: string;
  awardId: string | null;
  awardName: string | null;
  awardSlug: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  awardHref: string | null;
  sourceHref: string | null;
  sourceDomain: string;
  sourceDomainBasis:
    | "event_specific_source"
    | "current_source"
    | "award_homepage_fallback"
    | "unknown";
  visualCandidateId: string | null;
  evidenceRecordCount: number;
  evidenceHash: string;
  policyId: string;
  policyVersion: string;
  policyHash: string;
  evidenceFailureCode: string;
  evidenceFailureLabel: string;
  policyReasonCode: string;
  policyReasonLabel: string;
  likelyRepairCode: string;
  likelyRepairLabel: string;
  firstObservedAt: string;
  lastObservedAt: string;
  updatedAt: string;
  ageDays: number;
  ageBucket: AdminManualQuarantineAge;
  safeActions: {
    assignToMe: boolean;
    unassign: boolean;
    startReview: boolean;
    createsApiCharge: false;
    canRetry: false;
    canResolve: false;
  };
};

export type AdminManualQuarantineBacklog = {
  schemaVersion: string;
  countsAuthoritative: boolean;
  asOf: string | null;
  backlogRevision: number | null;
  registrySyncedAt: string | null;
  registryStateTotal: number;
  registryFresh: boolean;
  countsMatch: boolean;
  groupBy: AdminManualQuarantineGroupBy;
  sort: AdminManualQuarantineSort;
  unfilteredExactTotal: number;
  exactTotal: number;
  evidenceRecords: number;
  terminalCases: number;
  unassignedCases: number;
  chargeGatedCases: number;
  oldestObservedAt: string | null;
  page: number;
  pageSize: number;
  pageCount: number;
  clusterPage: number;
  clusterPageSize: number;
  clusterPageCount: number;
  exactClusterTotal: number;
  clusters: AdminManualQuarantineBacklogCluster[];
  items: AdminManualQuarantineBacklogItem[];
  facets: {
    domains: AdminManualQuarantineBacklogFacet[];
    evidenceFailures: AdminManualQuarantineBacklogFacet[];
    policyReasons: AdminManualQuarantineBacklogFacet[];
    repairs: AdminManualQuarantineBacklogFacet[];
    owners: AdminManualQuarantineBacklogFacet[];
    statuses: AdminManualQuarantineBacklogFacet[];
    ages: AdminManualQuarantineBacklogFacet[];
  };
};

export type AdminManualQuarantineBacklogLoadResult = {
  backlog: AdminManualQuarantineBacklog;
  available: boolean;
  loadErrors: string[];
};

export type AdminManualQuarantineSavedView = {
  id: string;
  name: string;
  filters: AdminManualQuarantineBacklogFilters;
  groupBy: AdminManualQuarantineGroupBy;
  sort: AdminManualQuarantineSort;
  pageSize: number;
  updatedAt: string;
};

export type AdminManualQuarantineSavedViewsLoadResult = {
  views: AdminManualQuarantineSavedView[];
  available: boolean;
  loadErrors: string[];
};

const uuidSchema = z.string().uuid();
const timestampSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidTimestamp, "Expected an ISO timestamp.");
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const positiveIntegerSchema = z.number().int().positive().safe();
const shortTextSchema = z.string().trim().min(1).max(500);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const facetSchema = z.object({
  key: shortTextSchema,
  label: shortTextSchema,
  cases: nonNegativeIntegerSchema,
});
const clusterSchema = z.object({
  key: shortTextSchema,
  label: shortTextSchema,
  cases: positiveIntegerSchema,
  evidence_records: nonNegativeIntegerSchema,
  terminal_cases: nonNegativeIntegerSchema,
  unassigned_cases: nonNegativeIntegerSchema,
  charge_gated_cases: nonNegativeIntegerSchema,
  oldest_observed_at: timestampSchema.nullable(),
  source_domain: shortTextSchema,
  evidence_failure_code: shortTextSchema,
  evidence_failure_label: shortTextSchema,
  policy_reason_code: shortTextSchema,
  policy_reason_label: shortTextSchema,
  likely_repair_code: shortTextSchema,
  likely_repair_label: shortTextSchema,
});
const safeActionsSchema = z.object({
  assign_to_me: z.boolean(),
  unassign: z.boolean(),
  start_review: z.boolean(),
  creates_api_charge: z.literal(false),
  can_retry: z.literal(false),
  can_resolve: z.literal(false),
});
const backlogItemSchema = z.object({
  id: uuidSchema,
  quarantine_key: shortTextSchema,
  case_key: shortTextSchema,
  category: z.enum(["public_page", "visual_review"]),
  status: z.enum(manualQuarantineStatusValues),
  terminal: z.boolean(),
  terminal_failure_count: nonNegativeIntegerSchema,
  severity: z.enum(["high", "medium", "low"]),
  public_impact: z.enum([
    "blocked",
    "delayed",
    "protected",
    "none",
    "unknown",
  ]),
  functional_owner: shortTextSchema,
  assigned_to_user_id: uuidSchema.nullable(),
  assigned_to_email: z.string().trim().min(1).max(320).nullable(),
  assigned_at: timestampSchema.nullable(),
  retry_mode: shortTextSchema,
  retry_charge: z.enum(["none", "will_charge", "may_charge", "unknown"]),
  title: z.string().trim().min(1).max(2_000),
  reason_code: shortTextSchema,
  reason: z.string().trim().min(1).max(10_000),
  recommended_action: z.string().trim().min(1).max(5_000),
  award_id: uuidSchema.nullable(),
  award_name: z.string().trim().min(1).max(500).nullable(),
  award_slug: z.string().trim().min(1).max(500).nullable(),
  source_id: uuidSchema.nullable(),
  source_url: z.string().trim().max(10_000).nullable(),
  source_domain: shortTextSchema,
  source_domain_basis: z.enum([
    "event_specific_source",
    "current_source",
    "award_homepage_fallback",
    "unknown",
  ]),
  visual_candidate_id: uuidSchema.nullable(),
  evidence_record_count: positiveIntegerSchema,
  evidence_hash: hashSchema,
  policy_id: shortTextSchema,
  policy_version: shortTextSchema,
  policy_hash: hashSchema,
  evidence_failure_code: shortTextSchema,
  evidence_failure_label: shortTextSchema,
  policy_reason_code: shortTextSchema,
  policy_reason_label: shortTextSchema,
  likely_repair_code: shortTextSchema,
  likely_repair_label: shortTextSchema,
  first_observed_at: timestampSchema,
  last_observed_at: timestampSchema,
  updated_at: timestampSchema,
  age_days: nonNegativeIntegerSchema,
  age_bucket: z.enum(manualQuarantineAgeValues),
  safe_actions: safeActionsSchema,
});
const backlogPayloadSchema = z.object({
  schema_version: z.literal("manual-quarantine-backlog-v1"),
  as_of: timestampSchema,
  as_of_at: timestampSchema,
  backlog_revision: positiveIntegerSchema,
  registry_synced_at: timestampSchema,
  registry_state_total: nonNegativeIntegerSchema,
  registry_fresh: z.boolean(),
  counts_match: z.boolean(),
  group_by: z.enum(manualQuarantineGroupByValues),
  sort: z.enum(manualQuarantineSortValues),
  unfiltered_exact_total: nonNegativeIntegerSchema,
  exact_total: nonNegativeIntegerSchema,
  evidence_records: nonNegativeIntegerSchema,
  terminal_cases: nonNegativeIntegerSchema,
  unassigned_cases: nonNegativeIntegerSchema,
  charge_gated_cases: nonNegativeIntegerSchema,
  oldest_observed_at: timestampSchema.nullable(),
  page: positiveIntegerSchema,
  page_size: z.union([
    z.literal(10),
    z.literal(25),
    z.literal(50),
    z.literal(100),
  ]),
  page_count: positiveIntegerSchema,
  cluster_page: positiveIntegerSchema,
  cluster_page_size: z.number().int().min(6).max(48),
  cluster_page_count: positiveIntegerSchema,
  exact_cluster_total: nonNegativeIntegerSchema,
  clusters: z.array(clusterSchema),
  items: z.array(backlogItemSchema),
  facets: z.object({
    domains: z.array(facetSchema),
    evidence_failures: z.array(facetSchema),
    policy_reasons: z.array(facetSchema),
    repairs: z.array(facetSchema),
    owners: z.array(facetSchema),
    statuses: z.array(facetSchema),
    ages: z.array(facetSchema),
  }),
});
const savedViewFiltersSchema = z.object({
  domains: z.array(z.string().trim().min(1).max(180)).max(20),
  evidence_failures: z.array(z.string().trim().min(1).max(180)).max(20),
  policy_reasons: z.array(z.string().trim().min(1).max(180)).max(20),
  repairs: z.array(z.string().trim().min(1).max(180)).max(20),
  owners: z.array(z.string().trim().min(1).max(180)).max(20),
  statuses: z.array(z.enum(manualQuarantineStatusValues)).max(2),
  age_bucket: z.enum(manualQuarantineAgeValues).nullable(),
  search: z.string().max(160),
});
const savedViewRowSchema = z.object({
  id: uuidSchema,
  name: z.string().trim().min(1).max(80),
  filters: savedViewFiltersSchema,
  group_by: z.enum(manualQuarantineGroupByValues),
  sort_key: z.enum(manualQuarantineSortValues),
  page_size: z.union([
    z.literal(10),
    z.literal(25),
    z.literal(50),
    z.literal(100),
  ]),
  updated_at: timestampSchema,
});

type SearchParamValue = string | string[] | undefined;
export type AdminManualQuarantineBacklogSearchParams = Record<
  string,
  SearchParamValue
>;

export function parseAdminManualQuarantineBacklogQuery(
  params: AdminManualQuarantineBacklogSearchParams,
): AdminManualQuarantineBacklogQuery {
  const activeViewId = cleanText(first(params.mq_view));
  const snapshotAt = cleanText(first(params.mq_snapshot)).slice(0, 80);
  const asOfAt = cleanText(first(params.mq_as_of)).slice(0, 80);
  return {
    page: boundedPositiveInt(first(params.mq_page), 1, 1_000_000),
    pageSize: allowedPageSize(first(params.mq_page_size)),
    clusterPage: boundedPositiveInt(
      first(params.mq_cluster_page),
      1,
      1_000_000,
    ),
    clusterPageSize: 12,
    groupBy: allowedValue(
      first(params.mq_group_by),
      manualQuarantineGroupByValues,
      "repair_group",
    ),
    sort: allowedValue(
      first(params.mq_sort),
      manualQuarantineSortValues,
      "oldest",
    ),
    domains: stringList(params.mq_domain),
    evidenceFailures: stringList(params.mq_failure),
    policyReasons: stringList(params.mq_policy),
    repairs: stringList(params.mq_repair),
    owners: stringList(params.mq_owner),
    statuses: enumList(
      params.mq_status,
      manualQuarantineStatusValues,
    ),
    ageBucket: optionalAllowedValue(
      first(params.mq_age),
      manualQuarantineAgeValues,
    ),
    search: cleanText(first(params.mq_search)).slice(0, 160),
    activeViewId: isUuid(activeViewId) ? activeViewId : null,
    snapshotAt: isValidTimestamp(snapshotAt) ? snapshotAt : null,
    snapshotRevision: optionalPositiveSafeInt(first(params.mq_revision)),
    asOfAt: isValidTimestamp(asOfAt) ? asOfAt : null,
  };
}

export async function loadAdminManualQuarantineBacklog(
  admin: AdminClient,
  query: AdminManualQuarantineBacklogQuery,
): Promise<AdminManualQuarantineBacklogLoadResult> {
  let result: Awaited<ReturnType<AdminClient["rpc"]>>;
  try {
    result = await admin.rpc("list_manual_quarantine_backlog", {
      p_page: query.page,
      p_page_size: query.pageSize,
      p_cluster_page: query.clusterPage,
      p_cluster_page_size: query.clusterPageSize,
      p_group_by: query.groupBy,
      p_sort: query.sort,
      p_domains: query.domains.length > 0 ? query.domains : null,
      p_evidence_failures:
        query.evidenceFailures.length > 0 ? query.evidenceFailures : null,
      p_policy_reasons:
        query.policyReasons.length > 0 ? query.policyReasons : null,
      p_repairs: query.repairs.length > 0 ? query.repairs : null,
      p_owners: query.owners.length > 0 ? query.owners : null,
      p_statuses: query.statuses.length > 0 ? query.statuses : null,
      p_age_bucket: query.ageBucket,
      p_search: query.search || null,
      p_expected_synced_at: query.snapshotAt,
      p_expected_revision: query.snapshotRevision,
      p_as_of_at: query.asOfAt,
    });
  } catch (error) {
    console.error("Manual quarantine backlog RPC threw", safeErrorDetails(error));
    return unavailableBacklogResult(
      query,
      "The clustered backlog could not be loaded safely. Refresh and try again.",
    );
  }

  if (result.error || result.data === null) {
    if (!missingBacklogContract(result.error)) {
      console.error("Manual quarantine backlog RPC failed", {
        code: result.error?.code,
        message: result.error?.message,
      });
    }
    return {
      backlog: emptyAdminManualQuarantineBacklog(query),
      available: false,
      loadErrors: [
        missingBacklogContract(result.error)
          ? "The clustered backlog database contract is not available for this deployment yet. Exact registry accounting remains visible above."
          : "The clustered backlog could not be loaded safely. Refresh and try again.",
      ],
    };
  }

  const parsed = parseAdminManualQuarantineBacklogPayload(result.data, query);
  if (!parsed.success) {
    console.error("Manual quarantine backlog contract rejected", {
      reason: parsed.reason,
    });
    return unavailableBacklogResult(
      query,
      "The clustered backlog returned incomplete accounting, so no queue totals or actions are being presented.",
    );
  }

  const backlog = parsed.backlog;
  if (!backlog.registryFresh || !backlog.countsMatch) {
    return {
      backlog,
      available: false,
      loadErrors: [
        !backlog.countsMatch
          ? `The exact queue count (${formatNumber(backlog.unfilteredExactTotal)}) does not match the durable registry state (${formatNumber(backlog.registryStateTotal)}). Wait for the next no-charge quarantine sync.`
          : "The clustered backlog is stale. Wait for the next no-charge quarantine sync before acting.",
      ],
    };
  }

  return { backlog, available: true, loadErrors: [] };
}

export async function loadAdminManualQuarantineSavedViews(
  admin: AdminClient,
  userId: string,
): Promise<AdminManualQuarantineSavedViewsLoadResult> {
  if (!isUuid(userId)) {
    return {
      views: [],
      available: false,
      loadErrors: ["Saved backlog views could not be loaded safely."],
    };
  }

  let result;
  try {
    result = await admin
      .from("manual_quarantine_saved_views")
      .select("id, name, filters, group_by, sort_key, page_size, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true });
  } catch (error) {
    console.error("Manual quarantine saved views query threw", safeErrorDetails(error));
    return {
      views: [],
      available: false,
      loadErrors: ["Saved backlog views could not be loaded safely."],
    };
  }

  if (result.error) {
    if (!missingBacklogContract(result.error)) {
      console.error("Manual quarantine saved views query failed", {
        code: result.error.code,
        message: result.error.message,
      });
    }
    return {
      views: [],
      available: false,
      loadErrors: [
        missingBacklogContract(result.error)
          ? "Saved backlog views will be available after the operator-backlog migration."
          : "Saved backlog views could not be loaded safely.",
      ],
    };
  }

  const parsed = z.array(savedViewRowSchema).safeParse(result.data);
  if (!parsed.success) {
    console.error("Manual quarantine saved views contract rejected", {
      issues: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
    return {
      views: [],
      available: false,
      loadErrors: [
        "Saved backlog views returned incomplete data and were not displayed.",
      ],
    };
  }

  return {
    views: parsed.data.map(mapSavedView),
    available: true,
    loadErrors: [],
  };
}

export function adminManualQuarantineBacklogHref(
  query: AdminManualQuarantineBacklogQuery,
  patch: Partial<AdminManualQuarantineBacklogQuery> = {},
) {
  const next = { ...query, ...patch };
  const params = new URLSearchParams({ tab: "quarantine" });
  if (next.page !== 1) params.set("mq_page", String(next.page));
  if (next.pageSize !== 25) params.set("mq_page_size", String(next.pageSize));
  if (next.clusterPage !== 1) {
    params.set("mq_cluster_page", String(next.clusterPage));
  }
  if (next.groupBy !== "repair_group") {
    params.set("mq_group_by", next.groupBy);
  }
  if (next.sort !== "oldest") params.set("mq_sort", next.sort);
  appendAll(params, "mq_domain", next.domains);
  appendAll(params, "mq_failure", next.evidenceFailures);
  appendAll(params, "mq_policy", next.policyReasons);
  appendAll(params, "mq_repair", next.repairs);
  appendAll(params, "mq_owner", next.owners);
  appendAll(params, "mq_status", next.statuses);
  if (next.ageBucket) params.set("mq_age", next.ageBucket);
  if (next.search) params.set("mq_search", next.search);
  if (next.activeViewId) params.set("mq_view", next.activeViewId);
  if (next.snapshotAt) params.set("mq_snapshot", next.snapshotAt);
  if (next.snapshotRevision) {
    params.set("mq_revision", String(next.snapshotRevision));
  }
  if (next.asOfAt) params.set("mq_as_of", next.asOfAt);
  return `/dashboard/admin/issues?${params.toString()}`;
}

export function adminManualQuarantineSavedViewHref(
  view: AdminManualQuarantineSavedView,
) {
  return adminManualQuarantineBacklogHref(
    {
      ...defaultAdminManualQuarantineBacklogQuery(),
      ...view.filters,
      groupBy: view.groupBy,
      sort: view.sort,
      pageSize: view.pageSize,
      activeViewId: view.id,
      snapshotAt: null,
      snapshotRevision: null,
      asOfAt: null,
    },
    {},
  );
}

export function adminManualQuarantineClusterHref(
  query: AdminManualQuarantineBacklogQuery,
  clusterKey: string,
) {
  const patch: Partial<AdminManualQuarantineBacklogQuery> = {
    page: 1,
    clusterPage: 1,
    activeViewId: null,
    snapshotAt: null,
    snapshotRevision: null,
    asOfAt: null,
  };
  if (query.groupBy === "repair_group") {
    const cluster = queryClusterKey(clusterKey);
    if (cluster) {
      patch.domains = [cluster.sourceDomain];
      patch.evidenceFailures = [cluster.evidenceFailure];
      patch.policyReasons = [cluster.policyReason];
      patch.repairs = [cluster.likelyRepair];
    }
  }
  if (query.groupBy === "domain") patch.domains = [clusterKey];
  if (query.groupBy === "evidence_failure") {
    patch.evidenceFailures = [clusterKey];
  }
  if (query.groupBy === "policy_reason") patch.policyReasons = [clusterKey];
  if (query.groupBy === "likely_repair") patch.repairs = [clusterKey];
  return adminManualQuarantineBacklogHref(query, patch);
}

export function defaultAdminManualQuarantineBacklogQuery(): AdminManualQuarantineBacklogQuery {
  return {
    page: 1,
    pageSize: 25,
    clusterPage: 1,
    clusterPageSize: 12,
    groupBy: "repair_group",
    sort: "oldest",
    domains: [],
    evidenceFailures: [],
    policyReasons: [],
    repairs: [],
    owners: [],
    statuses: [],
    ageBucket: null,
    search: "",
    activeViewId: null,
    snapshotAt: null,
    snapshotRevision: null,
    asOfAt: null,
  };
}

export function backlogFiltersFromQuery(
  query: AdminManualQuarantineBacklogQuery,
): AdminManualQuarantineBacklogFilters {
  return {
    domains: query.domains,
    evidenceFailures: query.evidenceFailures,
    policyReasons: query.policyReasons,
    repairs: query.repairs,
    owners: query.owners,
    statuses: query.statuses,
    ageBucket: query.ageBucket,
    search: query.search,
  };
}

export function parseAdminManualQuarantineBacklogPayload(
  value: Json,
  query: AdminManualQuarantineBacklogQuery,
):
  | { success: true; backlog: AdminManualQuarantineBacklog }
  | { success: false; reason: string } {
  const parsed = backlogPayloadSchema.safeParse(value);
  if (!parsed.success) {
    return {
      success: false,
      reason:
        parsed.error.issues[0]?.path.join(".") || "invalid backlog payload",
    };
  }

  const row = parsed.data;
  const invariantFailure = backlogInvariantFailure(row, query);
  if (invariantFailure) return { success: false, reason: invariantFailure };

  const backlog: AdminManualQuarantineBacklog = {
    schemaVersion: row.schema_version,
    countsAuthoritative: row.registry_fresh && row.counts_match,
    asOf: row.as_of_at,
    backlogRevision: row.backlog_revision,
    registrySyncedAt: row.registry_synced_at,
    registryStateTotal: row.registry_state_total,
    registryFresh: row.registry_fresh,
    countsMatch: row.counts_match,
    groupBy: row.group_by,
    sort: row.sort,
    unfilteredExactTotal: row.unfiltered_exact_total,
    exactTotal: row.exact_total,
    evidenceRecords: row.evidence_records,
    terminalCases: row.terminal_cases,
    unassignedCases: row.unassigned_cases,
    chargeGatedCases: row.charge_gated_cases,
    oldestObservedAt: row.oldest_observed_at,
    page: row.page,
    pageSize: row.page_size,
    pageCount: row.page_count,
    clusterPage: row.cluster_page,
    clusterPageSize: row.cluster_page_size,
    clusterPageCount: row.cluster_page_count,
    exactClusterTotal: row.exact_cluster_total,
    clusters: row.clusters.map(mapCluster),
    items: row.items.map(mapItem),
    facets: {
      domains: row.facets.domains.map(mapFacet),
      evidenceFailures: row.facets.evidence_failures.map(mapFacet),
      policyReasons: row.facets.policy_reasons.map(mapFacet),
      repairs: row.facets.repairs.map(mapFacet),
      owners: row.facets.owners.map(mapFacet),
      statuses: row.facets.statuses.map(mapFacet),
      ages: row.facets.ages.map(mapFacet),
    },
  };
  return { success: true, backlog };
}

type BacklogPayload = z.infer<typeof backlogPayloadSchema>;
type BacklogClusterRow = z.infer<typeof clusterSchema>;
type BacklogItemRow = z.infer<typeof backlogItemSchema>;
type BacklogFacetRow = z.infer<typeof facetSchema>;
type SavedViewRow = z.infer<typeof savedViewRowSchema>;

function mapCluster(row: BacklogClusterRow) {
  return {
    key: row.key,
    label: row.label,
    cases: row.cases,
    evidenceRecords: row.evidence_records,
    terminalCases: row.terminal_cases,
    unassignedCases: row.unassigned_cases,
    chargeGatedCases: row.charge_gated_cases,
    oldestObservedAt: row.oldest_observed_at,
    sourceDomain: row.source_domain,
    evidenceFailureCode: row.evidence_failure_code,
    evidenceFailureLabel: row.evidence_failure_label,
    policyReasonCode: row.policy_reason_code,
    policyReasonLabel: row.policy_reason_label,
    likelyRepairCode: row.likely_repair_code,
    likelyRepairLabel: row.likely_repair_label,
  } satisfies AdminManualQuarantineBacklogCluster;
}

function mapItem(row: BacklogItemRow) {
  const safeSlug =
    row.award_slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.award_slug)
      ? row.award_slug
      : null;
  const awardHref =
    row.award_id && row.award_name
      ? dashboardAwardPath(safeSlug, row.award_name, row.award_id)
      : null;
  const sourceHref = safeExternalUrl(row.source_url);
  return {
    id: row.id,
    quarantineKey: row.quarantine_key,
    caseKey: row.case_key,
    category: row.category,
    status: row.status,
    terminal: row.terminal,
    terminalFailureCount: row.terminal_failure_count,
    severity: row.severity,
    publicImpact: row.public_impact,
    functionalOwner: row.functional_owner,
    assignedToUserId: row.assigned_to_user_id,
    assignedToEmail: row.assigned_to_email,
    assignedAt: row.assigned_at,
    retryMode: row.retry_mode,
    retryCharge: row.retry_charge,
    title: row.title,
    reasonCode: row.reason_code,
    reason: row.reason,
    recommendedAction: row.recommended_action,
    awardId: row.award_id,
    awardName: row.award_name,
    awardSlug: safeSlug,
    sourceId: row.source_id,
    sourceUrl: sourceHref,
    awardHref,
    sourceHref,
    sourceDomain: row.source_domain,
    sourceDomainBasis: row.source_domain_basis,
    visualCandidateId: row.visual_candidate_id,
    evidenceRecordCount: row.evidence_record_count,
    evidenceHash: row.evidence_hash,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    policyHash: row.policy_hash,
    evidenceFailureCode: row.evidence_failure_code,
    evidenceFailureLabel: row.evidence_failure_label,
    policyReasonCode: row.policy_reason_code,
    policyReasonLabel: row.policy_reason_label,
    likelyRepairCode: row.likely_repair_code,
    likelyRepairLabel: row.likely_repair_label,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    updatedAt: row.updated_at,
    ageDays: row.age_days,
    ageBucket: row.age_bucket,
    safeActions: {
      assignToMe: row.safe_actions.assign_to_me,
      unassign: row.safe_actions.unassign,
      startReview: row.safe_actions.start_review,
      createsApiCharge: false,
      canRetry: false,
      canResolve: false,
    },
  } satisfies AdminManualQuarantineBacklogItem;
}

function mapFacet(row: BacklogFacetRow) {
  return {
    key: row.key,
    label: row.label,
    cases: row.cases,
  } satisfies AdminManualQuarantineBacklogFacet;
}

function mapSavedView(row: SavedViewRow): AdminManualQuarantineSavedView {
  const filters = row.filters;
  return {
    id: row.id,
    name: row.name,
    filters: {
      domains: cleanSavedViewList(filters.domains),
      evidenceFailures: cleanSavedViewList(filters.evidence_failures),
      policyReasons: cleanSavedViewList(filters.policy_reasons),
      repairs: cleanSavedViewList(filters.repairs),
      owners: cleanSavedViewList(filters.owners),
      statuses: [...new Set(filters.statuses)],
      ageBucket: filters.age_bucket,
      search: cleanText(filters.search).slice(0, 160),
    },
    groupBy: row.group_by,
    sort: row.sort_key,
    pageSize: row.page_size,
    updatedAt: row.updated_at,
  };
}

function emptyAdminManualQuarantineBacklog(
  query: AdminManualQuarantineBacklogQuery,
): AdminManualQuarantineBacklog {
  return {
    schemaVersion: "manual-quarantine-backlog-v1",
    countsAuthoritative: false,
    asOf: null,
    backlogRevision: null,
    registrySyncedAt: null,
    registryStateTotal: 0,
    registryFresh: false,
    countsMatch: false,
    groupBy: query.groupBy,
    sort: query.sort,
    unfilteredExactTotal: 0,
    exactTotal: 0,
    evidenceRecords: 0,
    terminalCases: 0,
    unassignedCases: 0,
    chargeGatedCases: 0,
    oldestObservedAt: null,
    page: 1,
    pageSize: query.pageSize,
    pageCount: 1,
    clusterPage: 1,
    clusterPageSize: query.clusterPageSize,
    clusterPageCount: 1,
    exactClusterTotal: 0,
    clusters: [],
    items: [],
    facets: {
      domains: [],
      evidenceFailures: [],
      policyReasons: [],
      repairs: [],
      owners: [],
      statuses: [],
      ages: [],
    },
  };
}

function backlogInvariantFailure(
  row: BacklogPayload,
  query: AdminManualQuarantineBacklogQuery,
) {
  if (row.group_by !== query.groupBy || row.sort !== query.sort) {
    return "response query identity did not match the request";
  }
  if (
    row.page_size !== query.pageSize ||
    row.cluster_page_size !== query.clusterPageSize
  ) {
    return "response page size did not match the request";
  }
  if (row.exact_total > row.unfiltered_exact_total) {
    return "filtered total exceeded the unfiltered total";
  }
  if (
    row.counts_match !==
    (row.registry_state_total === row.unfiltered_exact_total)
  ) {
    return "registry count agreement flag was inconsistent";
  }
  if (
    row.evidence_records < row.exact_total ||
    row.terminal_cases > row.exact_total ||
    row.unassigned_cases > row.exact_total ||
    row.charge_gated_cases > row.exact_total
  ) {
    return "filtered aggregate counts were inconsistent";
  }

  const pageCount = Math.max(1, Math.ceil(row.exact_total / row.page_size));
  const expectedPage = Math.min(query.page, pageCount);
  const expectedItems = pageSliceLength(
    row.exact_total,
    expectedPage,
    row.page_size,
  );
  if (
    row.page_count !== pageCount ||
    row.page !== expectedPage ||
    row.items.length !== expectedItems
  ) {
    return "item pagination did not account for every filtered case";
  }

  const clusterPageCount = Math.max(
    1,
    Math.ceil(row.exact_cluster_total / row.cluster_page_size),
  );
  const expectedClusterPage = Math.min(query.clusterPage, clusterPageCount);
  const expectedClusters = pageSliceLength(
    row.exact_cluster_total,
    expectedClusterPage,
    row.cluster_page_size,
  );
  if (
    row.exact_cluster_total > row.exact_total ||
    row.cluster_page_count !== clusterPageCount ||
    row.cluster_page !== expectedClusterPage ||
    row.clusters.length !== expectedClusters
  ) {
    return "cluster pagination did not account for every filtered cluster";
  }

  if (!hasUniqueKeys(row.items.map((item) => item.id))) {
    return "the item page contained duplicate cases";
  }
  if (!hasUniqueKeys(row.clusters.map((cluster) => cluster.key))) {
    return "the cluster page contained duplicate groups";
  }
  for (const cluster of row.clusters) {
    if (
      cluster.evidence_records < cluster.cases ||
      cluster.terminal_cases > cluster.cases ||
      cluster.unassigned_cases > cluster.cases ||
      cluster.charge_gated_cases > cluster.cases
    ) {
      return "a cluster contained inconsistent counts";
    }
  }

  const facetSets = Object.values(row.facets);
  for (const facets of facetSets) {
    if (
      !hasUniqueKeys(facets.map((facet) => facet.key)) ||
      facets.reduce((total, facet) => total + facet.cases, 0) !==
        row.unfiltered_exact_total
    ) {
      return "a facet set did not account for the full registry";
    }
  }

  if (
    query.snapshotAt &&
    Date.parse(query.snapshotAt) !== Date.parse(row.registry_synced_at)
  ) {
    return "response snapshot did not match the requested registry snapshot";
  }
  if (
    query.snapshotRevision &&
    query.snapshotRevision !== row.backlog_revision
  ) {
    return "response revision did not match the requested backlog snapshot";
  }
  if (
    query.asOfAt &&
    Date.parse(query.asOfAt) !== Date.parse(row.as_of_at)
  ) {
    return "response age clock did not match the requested backlog snapshot";
  }
  if (Date.parse(row.as_of) !== Date.parse(row.as_of_at)) {
    return "response age clocks were inconsistent";
  }
  return null;
}

function pageSliceLength(total: number, page: number, pageSize: number) {
  if (total === 0) return 0;
  return Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize));
}

function hasUniqueKeys(values: string[]) {
  return new Set(values).size === values.length;
}

function unavailableBacklogResult(
  query: AdminManualQuarantineBacklogQuery,
  message: string,
): AdminManualQuarantineBacklogLoadResult {
  return {
    backlog: emptyAdminManualQuarantineBacklog(query),
    available: false,
    loadErrors: [message],
  };
}

function first(value: SearchParamValue) {
  return Array.isArray(value) ? value[0] : value;
}

function stringList(value: SearchParamValue) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [
    ...new Set(
      values
        .flatMap((item) => item.split(","))
        .map((item) => cleanText(item).slice(0, 180))
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

function enumList<T extends string>(
  value: SearchParamValue,
  allowed: readonly T[],
) {
  const allowedSet = new Set<string>(allowed);
  return stringList(value).filter((item): item is T => allowedSet.has(item));
}

function allowedValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
) {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function optionalAllowedValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
) {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function allowedPageSize(value: unknown) {
  const parsed = Number(value);
  return [10, 25, 50, 100].includes(parsed) ? parsed : 25;
}

function boundedPositiveInt(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
}

function optionalPositiveSafeInt(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function appendAll(params: URLSearchParams, key: string, values: readonly string[]) {
  for (const value of values) params.append(key, value);
}

function queryClusterKey(value: string) {
  const [sourceDomain, evidenceFailure, policyReason, likelyRepair, ...extra] =
    value.split("|");
  if (
    extra.length > 0 ||
    !sourceDomain ||
    !evidenceFailure ||
    !policyReason ||
    !likelyRepair
  ) {
    return null;
  }
  return { sourceDomain, evidenceFailure, policyReason, likelyRepair };
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function cleanSavedViewList(values: string[]) {
  return [...new Set(values.map(cleanText).filter(Boolean))].slice(0, 20);
}

function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function isValidTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

type BacklogDatabaseError = {
  code?: string | null;
  message?: string | null;
};

function missingBacklogContract(error: BacklogDatabaseError | null | undefined) {
  const code = error?.code || "";
  const message = error?.message || "";
  return (
    /^(?:PGRST20[25]|42P01|42883)$/.test(code) ||
    /list_manual_quarantine_backlog|manual_quarantine_saved_views|schema cache|PGRST20[25]|42P01|42883/i.test(
      message,
    )
  );
}

function safeErrorDetails(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { type: typeof error };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
