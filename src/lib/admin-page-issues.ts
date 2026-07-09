import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  buildSourceAiCoverageRow,
  workerHasGeminiBlocker,
} from "@/lib/admin-ai-review-coverage";
import { pageAuditFindingCategory } from "@/lib/admin-page-audits";
import { sourceQualityDecision, type SourceQualitySource } from "@/lib/source-quality";

type AdminClient = SupabaseClient<Database>;
type LocalWorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

type AwardEmbed = {
  id: string;
  name: string;
  slug: string | null;
  status: "active" | "archived";
};

type SourceIssueRow = {
  id: string;
  shared_award_id: string;
  url: string;
  title: string;
  display_title: string | null;
  admin_review_status: "open" | "review_later";
  admin_review_note: string | null;
  admin_reviewed_at: string | null;
  admin_reviewed_by: string | null;
  page_description: string | null;
  page_metadata: unknown;
  page_metadata_generated_at: string | null;
  page_metadata_model: string | null;
  page_type: string;
  reason: string | null;
  source: string | null;
  submitted_by_user_id: string | null;
  last_checked_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
  updated_at: string;
  shared_awards: AwardEmbed | AwardEmbed[] | null;
};

type AwardIssueRow = {
  id: string;
  name: string;
  slug: string | null;
  official_homepage: string | null;
  structure_scan_error: string | null;
  last_structure_scan_at: string | null;
  updated_at: string;
};

type WorkerPageError = {
  key: string;
  sourceId: string | null;
  sourceUrl: string | null;
  message: string;
  workerName: string;
  runId: string;
  startedAt: string;
};

export type PageIssueSeverity = "high" | "medium" | "low";

export type AdminPageIssue = {
  key: string;
  category: string;
  area: string;
  severity: PageIssueSeverity;
  label: string;
  awardId: string | null;
  awardSlug: string | null;
  awardName: string;
  sourceId: string | null;
  sourceTitle: string;
  sourceUrl: string | null;
  message: string;
  currentValue: string | null;
  recommendedAction: string | null;
  relatedWorkerRunId: string | null;
  checkedAt: string | null;
  failures: number;
  resolvedAt?: string | null;
  suppressedAt?: string | null;
};

export type AdminPageIssueSummary = {
  sourceErrors: number;
  persistentSourceErrors: number;
  awardStructureErrors: number;
  recentWorkerPageErrors: number;
  missingSnapshots: number;
  missingPageInfo: number;
  reviewLater: number;
  sourceQualityRejected: number;
  suppressedChangeEvents: number;
  queueTotal: number;
  categoryCounts: Record<string, number>;
};

export type AdminReviewLaterSource = {
  id: string;
  awardId: string;
  awardSlug: string | null;
  awardName: string;
  sourceTitle: string;
  sourceUrl: string;
  message: string;
  note: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  failures: number;
};

export type AdminSuppressedChangeEvent = {
  id: string;
  awardId: string;
  sourceId: string | null;
  sourceTitle: string;
  sourceUrl: string;
  summary: string;
  reason: string | null;
  source: string | null;
  suppressedAt: string | null;
  detectedAt: string;
};

export type AdminPageIssueLoadResult = {
  summary: AdminPageIssueSummary;
  issues: AdminPageIssue[];
  loadErrors: string[];
};

export type AdminPageIssueOptions = {
  includeResolved?: boolean;
  includeSuppressed?: boolean;
  category?: string | null;
};

type CountResult = {
  count: number;
  error: { message: string } | null;
};

const sourceIssueSelect =
  "id, shared_award_id, url, title, display_title, admin_review_status, admin_review_note, admin_reviewed_at, admin_reviewed_by, page_description, page_metadata, page_metadata_generated_at, page_metadata_model, page_type, reason, source, submitted_by_user_id, last_checked_at, consecutive_failures, last_error, updated_at, shared_awards!inner(id, name, slug, status)";

export async function countActiveOpenSourcesWithVisualSnapshots(
  admin: AdminClient,
): Promise<CountResult> {
  const { count, error } = await admin
    .from("shared_award_source_visual_snapshots")
    .select("shared_award_source_id", { count: "exact", head: true })
    .not("latest_captured_at", "is", null);
  return {
    count: count || 0,
    error: error?.message ? { message: error.message } : null,
  };
}

export async function loadAdminPageIssues(
  admin: AdminClient,
  workerRuns?: LocalWorkerRun[],
  options: AdminPageIssueOptions = {},
): Promise<AdminPageIssueLoadResult> {
  const [
    sourceRowsResult,
    sourceCountResult,
    persistentSourceCountResult,
    awardRowsResult,
    awardCountResult,
    activeSourceCountResult,
    activeMetadataCountResult,
    visualSnapshotCountResult,
    workerRunResult,
  ] = await Promise.all([
    admin
      .from("shared_award_sources")
      .select(sourceIssueSelect)
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open")
      .not("last_error", "is", null)
      .order("consecutive_failures", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(80),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open")
      .not("last_error", "is", null),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open")
      .not("last_error", "is", null)
      .gte("consecutive_failures", 3),
    admin
      .from("shared_awards")
      .select("id, name, slug, official_homepage, structure_scan_error, last_structure_scan_at, updated_at")
      .eq("status", "active")
      .not("structure_scan_error", "is", null)
      .order("updated_at", { ascending: false })
      .limit(80),
    admin
      .from("shared_awards")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .not("structure_scan_error", "is", null),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open"),
    admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)", { count: "exact", head: true })
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open")
      .not("page_metadata_generated_at", "is", null),
    countActiveOpenSourcesWithVisualSnapshots(admin),
    workerRuns
      ? Promise.resolve({ data: workerRuns, error: null })
      : admin.from("local_worker_runs").select("*").order("started_at", { ascending: false }).limit(20),
  ]);

  const loadErrors = [
    sourceRowsResult.error?.message,
    sourceCountResult.error?.message,
    persistentSourceCountResult.error?.message,
    awardRowsResult.error?.message,
    awardCountResult.error?.message,
    activeSourceCountResult.error?.message,
    activeMetadataCountResult.error?.message,
    visualSnapshotCountResult.error?.message,
    workerRunResult.error?.message,
  ].filter((message): message is string => Boolean(message));

  const sourceRows = ((sourceRowsResult.data || []) as unknown as SourceIssueRow[]).filter((row) =>
    Boolean(row.last_error),
  );
  const awardRows = ((awardRowsResult.data || []) as AwardIssueRow[]).filter((row) =>
    Boolean(row.structure_scan_error),
  );
  const workerPageErrors = collectWorkerPageErrors((workerRunResult.data || []) as LocalWorkerRun[]);
  const workerSourceIds = [
    ...new Set(workerPageErrors.map((issue) => issue.sourceId).filter((id): id is string => Boolean(id))),
  ].slice(0, 120);
  const workerSourcesResult =
    workerSourceIds.length > 0
      ? await admin
          .from("shared_award_sources")
          .select(sourceIssueSelect)
          .eq("shared_awards.status", "active")
          .eq("admin_review_status", "open")
          .in("id", workerSourceIds)
      : { data: [], error: null };

  if (workerSourcesResult.error?.message) {
    loadErrors.push(workerSourcesResult.error.message);
  }

  const workerSourcesById = new Map(
    (((workerSourcesResult.data || []) as unknown as SourceIssueRow[]).map((row) => [row.id, row])),
  );
  const sourceQualityRejected = await loadSourceQualityRejectedRows(admin, loadErrors);
  const suppressedChangeEvents = await countSuppressedChangeEvents(admin, loadErrors);
  const aiCoverageIssues = await loadAiCoverageIssues(admin, loadErrors);
  const awardMissingPublicFactIssues = await loadAwardMissingPublicFactIssues(admin, loadErrors);
  const reconciliationIssues = await loadReconciliationIssueRows(admin, loadErrors);
  const pageAuditIssues = await loadPageAuditIssueRows(admin, loadErrors, options);
  const sourceIntakeIssues = await loadSourceIntakeIssueRows(admin, loadErrors);
  const workerIssues = geminiWorkerBlockerIssues((workerRunResult.data || []) as LocalWorkerRun[]);
  const sourceIssueIds = new Set(sourceRows.map((row) => row.id));
  const issues = [
    ...sourceRows.map(sourceRowToIssue),
    ...sourceQualityRejected.rows.map(sourceQualityRejectedRowToIssue),
    ...aiCoverageIssues,
    ...awardMissingPublicFactIssues,
    ...reconciliationIssues,
    ...pageAuditIssues,
    ...sourceIntakeIssues,
    ...workerIssues,
    ...awardRows.map(awardRowToIssue),
    ...workerPageErrors
      .filter((issue) => shouldShowWorkerPageError(issue, sourceIssueIds))
      .map((issue) => workerPageErrorToIssue(issue, workerSourcesById.get(issue.sourceId || "") || null)),
  ]
    .filter((issue) => options.includeResolved || !issue.resolvedAt)
    .filter((issue) => options.includeSuppressed || !issue.suppressedAt)
    .filter((issue) => !options.category || issue.category === options.category)
    .filter(uniqueIssue())
    .sort(comparePageIssues)
    .slice(0, 200);

  const activeSourceCount = activeSourceCountResult.count || 0;
  const visualSnapshotCount = visualSnapshotCountResult.count || 0;
  const activeMetadataCount = activeMetadataCountResult.count || 0;
  const summary = {
    sourceErrors: sourceCountResult.count || 0,
    persistentSourceErrors: persistentSourceCountResult.count || 0,
    awardStructureErrors: awardCountResult.count || 0,
    recentWorkerPageErrors: workerPageErrors.length,
    missingSnapshots: Math.max(0, activeSourceCount - visualSnapshotCount),
    missingPageInfo: Math.max(0, activeSourceCount - activeMetadataCount),
    reviewLater: await countReviewLaterSources(admin, loadErrors),
    sourceQualityRejected: sourceQualityRejected.count,
    suppressedChangeEvents,
    queueTotal: issues.length,
    categoryCounts: countIssueCategories(issues),
  };

  return { summary, issues, loadErrors };
}

export async function loadAdminReviewLaterSources(
  admin: AdminClient,
): Promise<{ sources: AdminReviewLaterSource[]; loadErrors: string[] }> {
  const { data, error } = await admin
    .from("shared_award_sources")
    .select(sourceIssueSelect)
    .eq("shared_awards.status", "active")
    .eq("admin_review_status", "review_later")
    .order("admin_reviewed_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(200);

  const rows = (data || []) as unknown as SourceIssueRow[];
  return {
    sources: rows.map(reviewLaterRowToSource),
    loadErrors: error?.message ? [error.message] : [],
  };
}

export async function loadAdminSuppressedChangeEvents(
  admin: AdminClient,
): Promise<{ events: AdminSuppressedChangeEvent[]; loadErrors: string[] }> {
  const { data, error } = await admin
    .from("shared_award_change_events")
    .select(
      "id, shared_award_id, shared_award_source_id, source_title, source_url, summary, suppression_reason, suppression_source, suppressed_at, detected_at",
    )
    .not("suppressed_at", "is", null)
    .order("suppressed_at", { ascending: false, nullsFirst: false })
    .limit(200);

  if (error?.message && isMissingRelationError(error.message)) {
    return {
      events: [],
      loadErrors: [],
    };
  }

  return {
    events: ((data || []) as Array<Record<string, unknown>>).map((row) => ({
      id: cleanText(row.id),
      awardId: cleanText(row.shared_award_id),
      sourceId: cleanText(row.shared_award_source_id) || null,
      sourceTitle: cleanDisplayTitle(cleanText(row.source_title || row.source_url || "Suppressed event")),
      sourceUrl: cleanText(row.source_url),
      summary: cleanText(row.summary),
      reason: cleanText(row.suppression_reason) || null,
      source: cleanText(row.suppression_source) || null,
      suppressedAt: cleanText(row.suppressed_at) || null,
      detectedAt: cleanText(row.detected_at),
    })),
    loadErrors: error?.message ? [error.message] : [],
  };
}

async function countReviewLaterSources(admin: AdminClient, loadErrors: string[]) {
  const { count, error } = await admin
    .from("shared_award_sources")
    .select("id, shared_awards!inner(status)", { count: "exact", head: true })
    .eq("shared_awards.status", "active")
    .eq("admin_review_status", "review_later");

  if (error?.message) loadErrors.push(error.message);
  return count || 0;
}

async function countSuppressedChangeEvents(admin: AdminClient, loadErrors: string[]) {
  const { count, error } = await admin
    .from("shared_award_change_events")
    .select("id", { count: "exact", head: true })
    .not("suppressed_at", "is", null);
  if (error?.message) {
    if (isMissingRelationError(error.message)) return 0;
    loadErrors.push(error.message);
  }
  return count || 0;
}

async function loadSourceQualityRejectedRows(admin: AdminClient, loadErrors: string[]) {
  const rows: SourceIssueRow[] = [];
  let count = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("shared_award_sources")
      .select(sourceIssueSelect)
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open")
      .range(from, from + 999);

    if (error) {
      loadErrors.push(error.message);
      break;
    }

    const page = (data || []) as unknown as SourceIssueRow[];
    for (const row of page) {
      const decision = sourceQualityDecision(sourceRowQualityInput(row), { purpose: "monitoring" });
      if (decision.allowed) continue;
      count += 1;
      if (rows.length < 80) rows.push(row);
    }
    if (page.length < 1000) break;
  }
  return { count, rows };
}

async function loadAiCoverageIssues(admin: AdminClient, loadErrors: string[]) {
  const issues: AdminPageIssue[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("shared_award_sources")
      .select(sourceIssueSelect)
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open")
      .range(from, from + 999);
    if (error) {
      loadErrors.push(error.message);
      break;
    }

    const rows = (data || []) as unknown as SourceIssueRow[];
    for (const row of rows) {
      const coverage = buildSourceAiCoverageRow(
        {
          ...sourceRowQualityInput(row),
          id: row.id,
          shared_award_id: row.shared_award_id,
          admin_review_status: row.admin_review_status,
          last_checked_at: row.last_checked_at,
        },
        coverageAward(sourceAward(row)),
      );
      const category = aiCoverageIssueCategory(coverage.category);
      if (!category) continue;
      issues.push(aiCoverageRowToIssue(row, category, coverage));
      if (issues.length >= 160) break;
    }
    if (rows.length < 1000 || issues.length >= 160) break;
  }
  return issues;
}

async function loadAwardMissingPublicFactIssues(admin: AdminClient, loadErrors: string[]) {
  const issues: AdminPageIssue[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("shared_awards")
      .select("id,name,slug,official_homepage,public_facts,updated_at")
      .eq("status", "active")
      .range(from, from + 999);
    if (error) {
      loadErrors.push(error.message);
      break;
    }
    const rows = (data || []) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (objectHasKeys(row.public_facts)) continue;
      issues.push({
        key: `award-missing-public-facts:${cleanText(row.id)}`,
        category: "award_missing_public_facts",
        area: "Award reconciliation",
        severity: "high",
        label: "Missing public facts",
        awardId: cleanText(row.id),
        awardSlug: cleanText(row.slug) || null,
        awardName: cleanText(row.name) || "Unknown award",
        sourceId: null,
        sourceTitle: "Award public facts",
        sourceUrl: cleanText(row.official_homepage) || null,
        message: "This active award does not have reconciled public_facts.",
        currentValue: "public_facts missing or empty",
        recommendedAction: "Queue the award for reconciliation and run the page audit before publishing facts.",
        relatedWorkerRunId: null,
        checkedAt: cleanText(row.updated_at) || null,
        failures: 0,
      });
      if (issues.length >= 80) break;
    }
    if (rows.length < 1000 || issues.length >= 80) break;
  }
  return issues;
}

async function loadReconciliationIssueRows(admin: AdminClient, loadErrors: string[]) {
  const rawAdmin = admin as unknown as SupabaseClient;
  const { data, error } = await rawAdmin
    .from("shared_award_reconciliation_queue")
    .select("id,shared_award_id,reason,status,error,completed_at,created_at,shared_awards(name,slug,official_homepage)")
    .in("status", ["failed", "processing"])
    .order("created_at", { ascending: false })
    .limit(80);
  if (error?.message) {
    if (isMissingRelationError(error.message)) return [];
    loadErrors.push(error.message);
    return [];
  }
  return ((data || []) as Array<Record<string, unknown>>).map(reconciliationRowToIssue);
}

async function loadPageAuditIssueRows(
  admin: AdminClient,
  loadErrors: string[],
  options: AdminPageIssueOptions,
) {
  const rawAdmin = admin as unknown as SupabaseClient;
  let query = rawAdmin
    .from("shared_award_page_audits")
    .select("id,shared_award_id,audit_status,severity,findings,suggested_fixes,field_conflicts,selected_fact_summary,public_page_snapshot,created_at,resolved_at,shared_awards(name,slug,official_homepage)")
    .neq("audit_status", "passed")
    .order("created_at", { ascending: false })
    .limit(120);
  if (!options.includeResolved) query = query.is("resolved_at", null);
  const { data, error } = await query;
  if (error?.message) {
    if (isMissingRelationError(error.message)) return [];
    loadErrors.push(error.message);
    return [];
  }
  return ((data || []) as Array<Record<string, unknown>>).map(pageAuditRowToIssue);
}

async function loadSourceIntakeIssueRows(admin: AdminClient, loadErrors: string[]) {
  const rawAdmin = admin as unknown as SupabaseClient;
  const { data, error } = await rawAdmin
    .from("source_page_requests")
    .select("id,award_name,homepage_url,status,status_reason,error,updated_at,worker_run_id")
    .in("status", ["failed", "needs_manual_review"])
    .order("updated_at", { ascending: false })
    .limit(80);
  if (error?.message) {
    if (isMissingRelationError(error.message)) return [];
    loadErrors.push(error.message);
    return [];
  }
  return ((data || []) as Array<Record<string, unknown>>).map(sourceIntakeRowToIssue);
}

function aiCoverageIssueCategory(category: string) {
  if (category === "unreviewed" || category === "needs_capture_baseline" || category === "incomplete_review" || category === "review_failed") return "unreviewed_open_source";
  if (category === "unclear" || category === "needs_manual_review") return "unclear_open_source";
  if (category === "unrelated_but_open") return "unrelated_source_still_open";
  if (category === "sibling_but_open") return "sibling_source_still_open";
  if (category === "missing_cycle_relevance") return "source_missing_cycle_relevance";
  if (category === "missing_evidence") return "source_missing_evidence";
  if (category === "generic_listing_but_open") return "source_quality_rejected_but_monitoring_enabled";
  return null;
}

function aiCoverageRowToIssue(
  row: SourceIssueRow,
  category: string,
  coverage: ReturnType<typeof buildSourceAiCoverageRow>,
): AdminPageIssue {
  const award = sourceAward(row);
  const severity: PageIssueSeverity =
    category === "unrelated_source_still_open" ||
    category === "sibling_source_still_open" ||
    category === "source_quality_rejected_but_monitoring_enabled"
      ? "high"
      : "medium";
  return {
    key: `ai-coverage:${category}:${row.id}`,
    category,
    area: "AI review coverage",
    severity,
    label: labelizeIssueCategory(category),
    awardId: award?.id || row.shared_award_id,
    awardSlug: award?.slug || null,
    awardName: award?.name || "Unknown award",
    sourceId: row.id,
    sourceTitle: cleanDisplayTitle(row.display_title || row.title || row.url),
    sourceUrl: row.url,
    message: `${coverage.category}: ${coverage.action_reason}.`,
    currentValue: coverage.ai_status,
    recommendedAction:
      coverage.planned_action === "move_to_review_later"
        ? "Move this source to review_later so it cannot feed facts or monitoring."
        : coverage.planned_action === "queue_ai_review"
          ? "Run the AI review coverage backfill in batch mode for this source."
          : "Review the source metadata and evidence before allowing it to contribute public facts.",
    relatedWorkerRunId: null,
    checkedAt: row.page_metadata_generated_at || row.last_checked_at || row.updated_at,
    failures: row.consecutive_failures || 0,
  };
}

function reconciliationRowToIssue(row: Record<string, unknown>): AdminPageIssue {
  const award = embeddedAward(row.shared_awards);
  const status = cleanText(row.status);
  return {
    key: `reconciliation:${cleanText(row.id)}`,
    category: "award_reconciliation_failed",
    area: "Award reconciliation",
    severity: status === "failed" ? "high" : "medium",
    label: status === "failed" ? "Reconciliation failed" : "Reconciliation stuck",
    awardId: cleanText(row.shared_award_id),
    awardSlug: award.slug,
    awardName: award.name || "Unknown award",
    sourceId: null,
    sourceTitle: cleanText(row.reason) || "Reconciliation queue",
    sourceUrl: award.officialHomepage,
    message: cleanText(row.error) || `Queue row is ${status || "not complete"}.`,
    currentValue: status || null,
    recommendedAction: "Inspect the reconciliation queue row, rerun reconciliation, and preserve last-known-good facts if the audit is critical.",
    relatedWorkerRunId: null,
    checkedAt: cleanText(row.completed_at || row.created_at) || null,
    failures: status === "failed" ? 1 : 0,
  };
}

function pageAuditRowToIssue(row: Record<string, unknown>): AdminPageIssue {
  const award = embeddedAward(row.shared_awards);
  const finding = firstAuditFinding(row);
  const findingCategory = pageAuditFindingCategory(cleanText(finding.code || finding.reason || finding.field_name || finding.message));
  const category = pageAuditIssueCategory(findingCategory, cleanText(row.severity));
  return {
    key: `page-audit:${cleanText(row.id)}`,
    category,
    area: "Page audit",
    severity: pageAuditSeverity(cleanText(row.severity)),
    label: labelizeIssueCategory(category),
    awardId: cleanText(row.shared_award_id),
    awardSlug: award.slug,
    awardName: award.name || "Unknown award",
    sourceId: null,
    sourceTitle: cleanText(finding.source_title || finding.sourceTitle || finding.field_name || "Public page audit"),
    sourceUrl: award.officialHomepage,
    message: cleanText(finding.message) || cleanText(findingCategory) || "Page audit finding.",
    currentValue: cleanText(finding.current_value || finding.currentValue || finding.current) || null,
    recommendedAction:
      cleanText(finding.suggested_fix || finding.suggestedFix || finding.expected) ||
      "Rerun award reconciliation and resolve the audit finding before publishing updated public facts.",
    relatedWorkerRunId: null,
    checkedAt: cleanText(row.created_at) || null,
    failures: 0,
    resolvedAt: cleanText(row.resolved_at) || null,
  };
}

function sourceIntakeRowToIssue(row: Record<string, unknown>): AdminPageIssue {
  const status = cleanText(row.status);
  return {
    key: `source-intake:${cleanText(row.id)}`,
    category: status === "failed" ? "source_intake_failed" : "source_intake_needs_manual_review",
    area: "Source intake",
    severity: status === "failed" ? "high" : "medium",
    label: status === "failed" ? "Intake failed" : "Manual intake review",
    awardId: null,
    awardSlug: null,
    awardName: cleanText(row.award_name) || "New source request",
    sourceId: null,
    sourceTitle: cleanDisplayTitle(cleanText(row.homepage_url) || "Source intake request"),
    sourceUrl: cleanText(row.homepage_url) || null,
    message: cleanText(row.error || row.status_reason) || `Source intake status is ${status}.`,
    currentValue: status,
    recommendedAction: "Open Source Intake, decide whether to retry, reject, attach to an award, or approve as a new award.",
    relatedWorkerRunId: cleanText(row.worker_run_id) || null,
    checkedAt: cleanText(row.updated_at) || null,
    failures: status === "failed" ? 1 : 0,
  };
}

function geminiWorkerBlockerIssues(workerRuns: LocalWorkerRun[]): AdminPageIssue[] {
  const run = workerRuns.find(workerHasGeminiBlocker);
  if (!run) return [];
  const metadata = objectValue(run.metadata);
  return [{
    key: `gemini-blocker:${run.id}`,
    category: "gemini_billing_blocked",
    area: "Gemini worker health",
    severity: "high",
    label: "Gemini blocked",
    awardId: null,
    awardSlug: null,
    awardName: "Gemini Batch / AI workers",
    sourceId: null,
    sourceTitle: run.worker_name,
    sourceUrl: null,
    message: cleanText(metadata.blocking_reason || metadata.stop_reason || run.error) || "Recent worker run indicates Gemini billing or quota is blocked.",
    currentValue: run.status,
    recommendedAction: "Restore Gemini billing/quota, then resume the queued batch/backfill workers.",
    relatedWorkerRunId: run.id,
    checkedAt: run.finished_at || run.started_at,
    failures: 1,
  }];
}

function sourceRowToIssue(row: SourceIssueRow): AdminPageIssue {
  const award = sourceAward(row);
  const message = row.last_error || "Latest source check failed.";
  return {
    key: `source:${row.id}`,
    category: "source_check_failed",
    area: "Source check",
    severity: sourceIssueSeverity(message, row.consecutive_failures),
    label: issueLabel(message),
    awardId: award?.id || row.shared_award_id,
    awardSlug: award?.slug || null,
    awardName: award?.name || "Unknown award",
    sourceId: row.id,
    sourceTitle: cleanDisplayTitle(row.display_title || row.title || row.url),
    sourceUrl: row.url,
    message,
    currentValue: row.last_error,
    recommendedAction: "Open the source, confirm whether it is still official and monitorable, then mark review_later if it is stale or blocked.",
    relatedWorkerRunId: null,
    checkedAt: row.last_checked_at || row.updated_at,
    failures: row.consecutive_failures || 0,
  };
}

function sourceQualityRejectedRowToIssue(row: SourceIssueRow): AdminPageIssue {
  const award = sourceAward(row);
  const decision = sourceQualityDecision(sourceRowQualityInput(row), { purpose: "monitoring" });
  return {
    key: `source-quality:${row.id}`,
    category: "source_quality_rejected_but_monitoring_enabled",
    area: "Source quality gate",
    severity: sourceQualityIssueSeverity(decision.reason),
    label: "Monitoring rejected",
    awardId: award?.id || row.shared_award_id,
    awardSlug: award?.slug || null,
    awardName: award?.name || "Unknown award",
    sourceId: row.id,
    sourceTitle: cleanDisplayTitle(row.display_title || row.title || row.url),
    sourceUrl: row.url,
    message: `Rejected before public display, fact aggregation, or monitoring: ${decision.reason}.`,
    currentValue: decision.reason,
    recommendedAction: "Move this source to review_later or correct its AI/source-quality metadata before it can monitor or feed public facts.",
    relatedWorkerRunId: null,
    checkedAt: row.page_metadata_generated_at || row.last_checked_at || row.updated_at,
    failures: row.consecutive_failures || 0,
  };
}

function sourceRowQualityInput(row: SourceIssueRow): SourceQualitySource {
  return {
    url: row.url,
    title: row.title,
    display_title: row.display_title,
    page_description: row.page_description,
    page_metadata: row.page_metadata,
    page_metadata_generated_at: row.page_metadata_generated_at,
    page_type: row.page_type,
    source: row.source,
    reason: row.reason,
    submitted_by_user_id: row.submitted_by_user_id,
  };
}

function reviewLaterRowToSource(row: SourceIssueRow): AdminReviewLaterSource {
  const award = sourceAward(row);
  return {
    id: row.id,
    awardId: award?.id || row.shared_award_id,
    awardSlug: award?.slug || null,
    awardName: award?.name || "Unknown award",
    sourceTitle: cleanDisplayTitle(row.display_title || row.title || row.url),
    sourceUrl: row.url,
    message: row.last_error || "Marked for later troubleshooting.",
    note: row.admin_review_note,
    reviewedAt: row.admin_reviewed_at,
    reviewedBy: row.admin_reviewed_by,
    failures: row.consecutive_failures || 0,
  };
}

function awardRowToIssue(row: AwardIssueRow): AdminPageIssue {
  const message = row.structure_scan_error || "Award detail scan failed.";
  return {
    key: `award:${row.id}`,
    category: "award_structure_scan_failed",
    area: "Award details",
    severity: awardIssueSeverity(message),
    label: issueLabel(message),
    awardId: row.id,
    awardSlug: row.slug,
    awardName: row.name,
    sourceId: null,
    sourceTitle: "Award detail summary",
    sourceUrl: row.official_homepage,
    message,
    currentValue: row.structure_scan_error,
    recommendedAction: "Rerun award structure scan or inspect the official homepage if the source shape changed.",
    relatedWorkerRunId: null,
    checkedAt: row.last_structure_scan_at || row.updated_at,
    failures: 0,
  };
}

function workerPageErrorToIssue(
  issue: WorkerPageError,
  source: SourceIssueRow | null,
): AdminPageIssue {
  const award = source ? sourceAward(source) : null;
  return {
    key: issue.key,
    category: "worker_page_error",
    area: workerArea(issue.message),
    severity: sourceIssueSeverity(issue.message, source?.consecutive_failures || 0),
    label: issueLabel(issue.message),
    awardId: award?.id || source?.shared_award_id || null,
    awardSlug: award?.slug || null,
    awardName: award?.name || "Unknown award",
    sourceId: issue.sourceId,
    sourceTitle: cleanDisplayTitle(source?.display_title || source?.title || issue.sourceUrl || "Worker page error"),
    sourceUrl: issue.sourceUrl || source?.url || null,
    message: issue.message,
    currentValue: issue.message,
    recommendedAction: "Review the worker error, then rerun the relevant capture, R2, AI, or publish worker after fixing the source condition.",
    relatedWorkerRunId: issue.runId,
    checkedAt: issue.startedAt,
    failures: source?.consecutive_failures || 0,
  };
}

function pageAuditIssueCategory(findingCategory: string, severity: string) {
  if (findingCategory === "deadline_conflict") return "deadline_conflict";
  if (findingCategory === "invented_future_deadline") return "invented_future_deadline";
  if (findingCategory === "stale_cycle_shown_upcoming") return "stale_cycle_shown_upcoming";
  if (findingCategory === "missing_amount_with_official_evidence") return "missing_amount_with_official_evidence";
  if (findingCategory === "sibling_source_contamination") return "sibling_source_still_open";
  if (findingCategory === "generic_listing_used_for_facts") return "public_facts_using_rejected_source";
  if (severity === "critical") return "page_audit_critical";
  return findingCategory || "page_audit_critical";
}

function pageAuditSeverity(value: string): PageIssueSeverity {
  if (value === "critical" || value === "error") return "high";
  if (value === "warning") return "medium";
  return "low";
}

function firstAuditFinding(row: Record<string, unknown>) {
  const findings = arrayValue(row.findings);
  if (findings.length > 0) return objectValue(findings[0]);
  const conflicts = arrayValue(row.field_conflicts);
  if (conflicts.length > 0) return objectValue(conflicts[0]);
  const fixes = arrayValue(row.suggested_fixes);
  if (fixes.length > 0) return objectValue(fixes[0]);
  return {};
}

function embeddedAward(value: unknown) {
  const object = Array.isArray(value) ? objectValue(value[0]) : objectValue(value);
  return {
    name: cleanText(object.name),
    slug: cleanText(object.slug) || null,
    officialHomepage: cleanText(object.official_homepage) || null,
  };
}

function uniqueIssue() {
  const seen = new Set<string>();
  return (issue: AdminPageIssue) => {
    if (seen.has(issue.key)) return false;
    seen.add(issue.key);
    return true;
  };
}

function countIssueCategories(issues: AdminPageIssue[]) {
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[issue.category] = (counts[issue.category] || 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );
}

function objectHasKeys(value: unknown) {
  return Object.keys(objectValue(value)).length > 0;
}

function labelizeIssueCategory(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function collectWorkerPageErrors(workerRuns: LocalWorkerRun[]) {
  const seen = new Set<string>();
  const errors: WorkerPageError[] = [];

  for (const run of workerRuns.slice(0, 20)) {
    const metadata = objectValue(run.metadata);
    const candidates = Array.isArray(metadata.errors) ? metadata.errors : [];
    for (const candidate of candidates) {
      const value = objectValue(candidate);
      const message = cleanText(value.message);
      const sourceId = cleanText(value.source_id || value.sourceId) || null;
      const sourceUrl = cleanText(value.source_url || value.sourceUrl) || null;
      if (!message || (!sourceId && !sourceUrl)) continue;

      const key = `${sourceId || sourceUrl}:${message.slice(0, 120)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push({
        key: `worker:${key}`,
        sourceId,
        sourceUrl,
        message,
        workerName: run.worker_name,
        runId: run.id,
        startedAt: run.started_at,
      });
    }
  }

  return errors.slice(0, 200);
}

function shouldShowWorkerPageError(issue: WorkerPageError, sourceIssueIds: Set<string>) {
  if (!issue.sourceId || !sourceIssueIds.has(issue.sourceId)) return true;
  return /\b(r2|upload|publish|baseline facts|gemini|api|batch)\b/i.test(issue.message);
}

function sourceAward(row: SourceIssueRow) {
  const embedded = row.shared_awards;
  return Array.isArray(embedded) ? embedded[0] || null : embedded;
}

function coverageAward(award: AwardEmbed | null) {
  if (!award) return null;
  return {
    id: award.id,
    name: award.name,
    slug: award.slug,
    status: award.status,
    public_facts: null,
  };
}

function sourceIssueSeverity(message: string, failures: number): PageIssueSeverity {
  const lower = message.toLowerCase();
  if (
    failures >= 5 ||
    /\b(404|not found|gone|enotfound|nxdomain|domain failed|ssl|certificate|cert_has_expired)\b/.test(lower)
  ) {
    return "high";
  }
  if (failures >= 3 || /\b(403|429|captcha|security_challenge|timeout|timed out|blocked)\b/.test(lower)) {
    return "medium";
  }
  return "low";
}

function sourceQualityIssueSeverity(reason: string): PageIssueSeverity {
  if (/unrelated|spam|hacked|sibling|access|job|career|payment|search|listing/i.test(reason)) return "high";
  if (/unclear|archived|not_program|baseline/i.test(reason)) return "medium";
  return "low";
}

function awardIssueSeverity(message: string): PageIssueSeverity {
  if (/stale|archived|reconciliation|does not exist|removed/i.test(message)) return "high";
  if (/no local screenshot|no baseline/i.test(message)) return "low";
  return "medium";
}

function issueLabel(message: string) {
  const lower = message.toLowerCase();
  if (/\b404|not found\b/.test(lower)) return "Broken link";
  if (/\b403\b|blocked|security_challenge|captcha/.test(lower)) return "Blocked page";
  if (/\b429\b|rate limit/.test(lower)) return "Rate limited";
  if (/timeout|timed out/.test(lower)) return "Timed out";
  if (/r2|upload/.test(lower)) return "Storage issue";
  if (/no local screenshot|no baseline/.test(lower)) return "Missing baseline";
  if (/gemini|api|batch/.test(lower)) return "AI extraction";
  if (/ssl|certificate|cert_has_expired/.test(lower)) return "Certificate";
  return "Check failed";
}

function workerArea(message: string) {
  if (/r2|upload/i.test(message)) return "R2 snapshot";
  if (/gemini|api|batch/i.test(message)) return "Page info";
  if (/publish/i.test(message)) return "Publishing";
  return "Worker error";
}

function comparePageIssues(left: AdminPageIssue, right: AdminPageIssue) {
  const severityDelta = severityRank(right.severity) - severityRank(left.severity);
  if (severityDelta !== 0) return severityDelta;
  const failureDelta = right.failures - left.failures;
  if (failureDelta !== 0) return failureDelta;
  return dateMs(right.checkedAt) - dateMs(left.checkedAt);
}

function severityRank(value: PageIssueSeverity) {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function dateMs(value: string | null) {
  const ms = value ? new Date(value).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function isMissingRelationError(message: string) {
  return /schema cache|does not exist|could not find.*column|column .* does not exist|42P01|42703|PGRST/i.test(
    message,
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanDisplayTitle(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}
