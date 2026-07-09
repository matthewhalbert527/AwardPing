import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
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
  checkedAt: string | null;
  failures: number;
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

type CountResult = {
  count: number;
  error: { message: string } | null;
};

const sourceIssueSelect =
  "id, shared_award_id, url, title, display_title, admin_review_status, admin_review_note, admin_reviewed_at, admin_reviewed_by, page_description, page_metadata, page_metadata_generated_at, page_type, reason, source, submitted_by_user_id, last_checked_at, consecutive_failures, last_error, updated_at, shared_awards!inner(id, name, slug, status)";

export async function countActiveOpenSourcesWithVisualSnapshots(
  admin: AdminClient,
): Promise<CountResult> {
  try {
    const [sourceIds, snapshotSourceIds] = await Promise.all([
      loadActiveOpenSourceIds(admin),
      loadVisualSnapshotSourceIds(admin),
    ]);
    const snapshotSet = new Set(snapshotSourceIds);
    return {
      count: sourceIds.filter((id) => snapshotSet.has(id)).length,
      error: null,
    };
  } catch (error) {
    return { count: 0, error: { message: errorMessage(error) } };
  }
}

export async function loadAdminPageIssues(
  admin: AdminClient,
  workerRuns?: LocalWorkerRun[],
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
  const sourceIssueIds = new Set(sourceRows.map((row) => row.id));
  const issues = [
    ...sourceRows.map(sourceRowToIssue),
    ...sourceQualityRejected.rows.map(sourceQualityRejectedRowToIssue),
    ...awardRows.map(awardRowToIssue),
    ...workerPageErrors
      .filter((issue) => shouldShowWorkerPageError(issue, sourceIssueIds))
      .map((issue) => workerPageErrorToIssue(issue, workerSourcesById.get(issue.sourceId || "") || null)),
  ]
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
    queueTotal: (sourceCountResult.count || 0) + (awardCountResult.count || 0) + sourceQualityRejected.count,
  };

  return { summary, issues, loadErrors };
}

async function loadActiveOpenSourceIds(admin: AdminClient) {
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("shared_award_sources")
      .select("id, shared_awards!inner(status)")
      .eq("shared_awards.status", "active")
      .eq("admin_review_status", "open")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data || []) as Array<{ id: string | null }>;
    ids.push(...rows.map((row) => row.id).filter((id): id is string => Boolean(id)));
    if (rows.length < 1000) break;
  }
  return ids;
}

async function loadVisualSnapshotSourceIds(admin: AdminClient) {
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("shared_award_source_visual_snapshots")
      .select("shared_award_source_id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data || []) as Array<{ shared_award_source_id: string | null }>;
    ids.push(
      ...rows
        .map((row) => row.shared_award_source_id)
        .filter((id): id is string => Boolean(id)),
    );
    if (rows.length < 1000) break;
  }
  return ids;
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
      loadErrors: ["Change-event suppression columns are not configured."],
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

function sourceRowToIssue(row: SourceIssueRow): AdminPageIssue {
  const award = sourceAward(row);
  const message = row.last_error || "Latest source check failed.";
  return {
    key: `source:${row.id}`,
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
    checkedAt: row.last_checked_at || row.updated_at,
    failures: row.consecutive_failures || 0,
  };
}

function sourceQualityRejectedRowToIssue(row: SourceIssueRow): AdminPageIssue {
  const award = sourceAward(row);
  const decision = sourceQualityDecision(sourceRowQualityInput(row), { purpose: "monitoring" });
  return {
    key: `source-quality:${row.id}`,
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
    checkedAt: issue.startedAt,
    failures: source?.consecutive_failures || 0,
  };
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

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "Unknown error");
  }
  return String(error || "Unknown error");
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

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanDisplayTitle(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}
