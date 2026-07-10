import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  explainSourceAiReviewStatus,
  sourceBaselineFacts,
  type SourceAiReviewSource,
} from "@/lib/source-ai-review-status";
import {
  sourceQualityDecision,
  type SourceQualitySource,
} from "@/lib/source-quality";

type AdminClient = SupabaseClient<Database>;
type LocalWorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];
type Json = Database["public"]["Tables"]["shared_awards"]["Row"]["public_facts"];

type AiCoverageAward = {
  id: string;
  name: string;
  slug: string | null;
  status: string;
  public_facts: Json;
};

type AiCoverageSource = SourceQualitySource & SourceAiReviewSource & {
  id: string;
  shared_award_id: string;
  admin_review_status: string | null;
  last_checked_at?: string | null;
  created_at?: string | null;
};

type PageAuditLite = {
  audit_status?: string | null;
  severity?: string | null;
  resolved_at?: string | null;
};

export const aiCoverageCategories = [
  "complete_accepted",
  "complete_rejected",
  "unreviewed",
  "incomplete_review",
  "unclear",
  "unrelated_but_open",
  "sibling_but_open",
  "archived_but_open",
  "not_program_page_but_open",
  "access_error_but_open",
  "generic_listing_but_open",
  "missing_cycle_relevance",
  "missing_evidence",
  "needs_capture_baseline",
  "review_failed",
  "needs_manual_review",
] as const;

export type AiCoverageCategory = (typeof aiCoverageCategories)[number];

export type SourceAiCoverageRow = {
  source_id: string | null;
  award_id: string | null;
  award_name: string | null;
  award_status: string | null;
  admin_review_status: string | null;
  ai_status: string;
  ai_complete: boolean;
  needs_ai_review: boolean;
  needs_manual_review: boolean;
  fact_eligible: boolean;
  public_eligible: boolean;
  monitor_eligible: boolean;
  category: AiCoverageCategory;
  planned_action: string;
  action_reason: string;
  rejection_reason: string;
  source_quality_reason: string;
  award_relevance: string | null;
  cycle_relevance: string | null;
  confidence: string | null;
  quality_flags: string[];
  has_page_metadata_generated_at: boolean;
  has_page_metadata_model: boolean;
  has_baseline_facts: boolean;
  has_baseline_facts_rejected: boolean;
  has_evidence_quotes: boolean;
  raw_award_relevance: string | null;
  raw_cycle_relevance: string | null;
  page_type: string | null;
  title: string | null;
  url: string | null;
};

export type WorkerSummary = {
  id: string;
  worker_name: string;
  status: string;
  ai_provider: string | null;
  checked_count: number;
  changed_count: number;
  failed_count: number;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  billing_blocked: boolean;
  blocking_reason: string | null;
} | null;

export type AiReviewCoverageSummary = {
  total_sources: number;
  open_sources: number;
  review_later_sources: number;
  sources_with_page_metadata_generated_at: number;
  sources_with_page_metadata_model: number;
  sources_with_baseline_facts: number;
  sources_with_baseline_facts_rejected: number;
  unreviewed_open_sources: number;
  open_sources_with_award_relevance_unrelated: number;
  open_sources_with_award_relevance_unclear: number;
  open_sources_missing_cycle_relevance: number;
  open_sources_with_cycle_relevance_unclear: number;
  open_sources_with_review_failed_status: number;
  open_sources_with_incomplete_or_invalid_metadata: number;
  fact_eligible_sources: number;
  monitor_eligible_sources: number;
  public_eligible_sources: number;
  active_awards: number;
  awards_with_no_public_facts: number;
  awards_with_public_facts: number;
  awards_with_no_reviewed_open_sources: number;
  awards_with_unresolved_source_fact_conflicts: number;
  critical_page_audit_failures: number;
  percent_complete_all_sources: number;
  percent_complete_open_sources: number;
  percent_complete_public_award_pages: number;
  status_counts: Record<string, number>;
  open_status_counts: Record<string, number>;
  category_counts: Record<string, number>;
  open_category_counts: Record<string, number>;
  source_quality_rejection_counts: Record<string, number>;
  latest_backfill_run_status: WorkerSummary;
  latest_baseline_facts_worker_status: WorkerSummary;
  latest_gemini_billing_quota_blocker: WorkerSummary;
  completion_blockers: Record<string, number>;
  completion_passed: boolean;
  active_open_source_count: number;
  awards_with_no_reviewed_open_source_examples: Array<{
    award_id: string;
    award_name: string;
    slug: string | null;
  }>;
  unresolved_source_fact_conflict_examples: Array<{
    award_id: string;
    award_name: string;
    slug: string | null;
  }>;
  problem_source_examples: SourceAiCoverageRow[];
};

const autoReviewLaterCategories = new Set<AiCoverageCategory>([
  "complete_rejected",
  "unclear",
  "unrelated_but_open",
  "sibling_but_open",
  "archived_but_open",
  "not_program_page_but_open",
  "access_error_but_open",
  "generic_listing_but_open",
  "needs_manual_review",
]);

const aiReviewCategories = new Set<AiCoverageCategory>([
  "unreviewed",
  "incomplete_review",
  "missing_cycle_relevance",
  "missing_evidence",
  "needs_capture_baseline",
  "review_failed",
]);

const hardCompletionBlockerCategories = new Set<AiCoverageCategory>([
  "unreviewed",
  "incomplete_review",
  "unclear",
  "unrelated_but_open",
  "sibling_but_open",
  "archived_but_open",
  "not_program_page_but_open",
  "access_error_but_open",
  "generic_listing_but_open",
  "missing_cycle_relevance",
  "missing_evidence",
  "needs_capture_baseline",
  "review_failed",
  "needs_manual_review",
]);

const adminLiveCoverageScanEnabled = process.env.AWARDPING_ADMIN_LIVE_COVERAGE_SCAN === "1";
const adminCoverageScanLimit = positiveIntegerFromEnv("AWARDPING_ADMIN_COVERAGE_SCAN_LIMIT", 2500);

export async function loadAiReviewCoverageSummary(
  admin: AdminClient,
  workerRuns: LocalWorkerRun[] = [],
): Promise<{ summary: AiReviewCoverageSummary; rows: SourceAiCoverageRow[]; warnings: string[]; loadErrors: string[] }> {
  const reportSummary = summarizeAiReviewCoverageFromWorkerRuns(workerRuns);
  if (!adminLiveCoverageScanEnabled && reportSummary) {
    return { summary: reportSummary, rows: [], warnings: [], loadErrors: [] };
  }

  const loadErrors: string[] = [];
  const warnings: string[] = [];
  const sourceLimit = adminLiveCoverageScanEnabled ? Number.POSITIVE_INFINITY : adminCoverageScanLimit;
  const [awards, sources, pageAudits] = await Promise.all([
    loadAiCoverageAwards(admin, loadErrors),
    loadAiCoverageSources(admin, loadErrors, sourceLimit),
    loadPageAuditLites(admin, warnings, loadErrors),
  ]);
  if (!adminLiveCoverageScanEnabled && sources.length >= sourceLimit) {
    warnings.push(`AI review coverage used a ${sourceLimit.toLocaleString()} source sample; set AWARDPING_ADMIN_LIVE_COVERAGE_SCAN=1 for a full live scan.`);
  }

  const awardById = new Map(awards.map((award) => [award.id, award]));
  const rows = sources.map((source) => buildSourceAiCoverageRow(source, awardById.get(source.shared_award_id) || null));
  return {
    summary: summarizeAiReviewCoverage({ awards, rows, pageAudits, workerRuns }),
    rows,
    warnings,
    loadErrors,
  };
}

export function summarizeAiReviewCoverageFromWorkerRuns(workerRuns: LocalWorkerRun[]): AiReviewCoverageSummary | null {
  const run = latestWorker(workerRuns, (candidate) => {
    const metadata = objectValue(candidate.metadata);
    return candidate.worker_name === "local-open-source-ai-coverage-backfill" ||
      cleanText(metadata.kind) === "open_source_ai_review_coverage_backfill" ||
      objectHasKeys(metadata.final_summary) ||
      objectHasKeys(metadata.initial_summary) ||
      objectHasKeys(metadata.coverage_summary);
  });
  if (!run) return null;

  const metadata = objectValue(run.metadata);
  const counts = objectValue(metadata.counts);
  const finalSummary = objectValue(metadata.final_summary || metadata.coverage_summary);
  const initialSummary = objectValue(metadata.initial_summary);
  const sourceSummary = objectHasKeys(finalSummary) ? finalSummary : initialSummary;
  const completionBlockers = objectValue(sourceSummary.completion_blockers || metadata.completion_blockers);
  const openSources = numberValue(sourceSummary.open_sources ?? counts.total_open_sources_scanned);
  const totalSources = numberValue(sourceSummary.total_sources ?? counts.total_sources_scanned ?? openSources);
  const completeAccepted = numberValue(sourceSummary.open_category_counts
    ? objectValue(sourceSummary.open_category_counts).complete_accepted
    : counts.complete_accepted);
  const completeRejected = numberValue(counts.complete_rejected ?? sourceSummary.sources_with_baseline_facts_rejected);
  const openCategoryCounts = reportOpenCategoryCounts(sourceSummary, counts);
  const categoryCounts = reportCategoryCounts(sourceSummary, counts, openCategoryCounts);
  const statusCounts = objectValue(sourceSummary.status_counts);
  const openStatusCounts = objectValue(sourceSummary.open_status_counts);
  const blockerCounts = reportCompletionBlockers(sourceSummary, counts, completionBlockers, workerHasGeminiBlocker(run));
  const activeAwards = numberValue(sourceSummary.active_awards ?? counts.active_awards);
  const awardsWithPublicFacts = numberValue(sourceSummary.awards_with_public_facts ?? counts.awards_with_public_facts);
  const completionPassed = boolValue(metadata.completion_passed ?? sourceSummary.completion_passed) ??
    Object.values(blockerCounts).every((value) => value === 0);

  return {
    total_sources: totalSources,
    open_sources: openSources,
    review_later_sources: numberValue(sourceSummary.review_later_sources ?? counts.review_later_sources),
    sources_with_page_metadata_generated_at: numberValue(sourceSummary.sources_with_page_metadata_generated_at),
    sources_with_page_metadata_model: numberValue(sourceSummary.sources_with_page_metadata_model),
    sources_with_baseline_facts: numberValue(sourceSummary.sources_with_baseline_facts),
    sources_with_baseline_facts_rejected: numberValue(sourceSummary.sources_with_baseline_facts_rejected ?? counts.complete_rejected),
    unreviewed_open_sources: numberValue(sourceSummary.unreviewed_open_sources ?? counts.unreviewed),
    open_sources_with_award_relevance_unrelated: numberValue(sourceSummary.open_sources_with_award_relevance_unrelated ?? counts.unrelated_but_open),
    open_sources_with_award_relevance_unclear: numberValue(sourceSummary.open_sources_with_award_relevance_unclear ?? counts.unclear),
    open_sources_missing_cycle_relevance: numberValue(sourceSummary.open_sources_missing_cycle_relevance ?? counts.missing_cycle_relevance),
    open_sources_with_cycle_relevance_unclear: numberValue(sourceSummary.open_sources_with_cycle_relevance_unclear),
    open_sources_with_review_failed_status: numberValue(sourceSummary.open_sources_with_review_failed_status ?? counts.review_failed),
    open_sources_with_incomplete_or_invalid_metadata: numberValue(sourceSummary.open_sources_with_incomplete_or_invalid_metadata ?? counts.incomplete_review),
    fact_eligible_sources: numberValue(sourceSummary.fact_eligible_sources ?? completeAccepted),
    monitor_eligible_sources: numberValue(sourceSummary.monitor_eligible_sources ?? completeAccepted),
    public_eligible_sources: numberValue(sourceSummary.public_eligible_sources ?? completeAccepted),
    active_awards: activeAwards,
    awards_with_no_public_facts: numberValue(sourceSummary.awards_with_no_public_facts),
    awards_with_public_facts: awardsWithPublicFacts,
    awards_with_no_reviewed_open_sources: numberValue(sourceSummary.awards_with_no_reviewed_open_sources),
    awards_with_unresolved_source_fact_conflicts: numberValue(sourceSummary.awards_with_unresolved_source_fact_conflicts),
    critical_page_audit_failures: numberValue(sourceSummary.critical_page_audit_failures),
    percent_complete_all_sources: numberValue(sourceSummary.percent_complete_all_sources) ||
      percent(completeAccepted + completeRejected, totalSources),
    percent_complete_open_sources: numberValue(sourceSummary.percent_complete_open_sources) ||
      percent(completeAccepted + completeRejected, openSources),
    percent_complete_public_award_pages: numberValue(sourceSummary.percent_complete_public_award_pages) ||
      percent(awardsWithPublicFacts, activeAwards),
    status_counts: normalizeNumberRecord(statusCounts),
    open_status_counts: normalizeNumberRecord(openStatusCounts),
    category_counts: categoryCounts,
    open_category_counts: openCategoryCounts,
    source_quality_rejection_counts: normalizeNumberRecord(objectValue(sourceSummary.source_quality_rejection_counts)),
    latest_backfill_run_status: workerSummary(run),
    latest_baseline_facts_worker_status: workerSummary(latestWorker(workerRuns, (candidate) =>
      /baseline.*facts|facts.*baseline/i.test(`${candidate.worker_name} ${JSON.stringify(candidate.metadata || {})}`),
    )),
    latest_gemini_billing_quota_blocker: workerSummary(latestWorker(workerRuns, workerHasGeminiBlocker)),
    completion_blockers: blockerCounts,
    completion_passed: completionPassed,
    active_open_source_count: numberValue(sourceSummary.active_open_source_count ?? openSources),
    awards_with_no_reviewed_open_source_examples: [],
    unresolved_source_fact_conflict_examples: [],
    problem_source_examples: [],
  };
}

export function buildSourceAiCoverageRow(source: AiCoverageSource, award: AiCoverageAward | null = null): SourceAiCoverageRow {
  const explanation = explainSourceAiReviewStatus(source);
  const factDecision = sourceQualityDecision(source, { purpose: "facts" });
  const publicDecision = sourceQualityDecision(source, { purpose: "public" });
  const monitorDecision = sourceQualityDecision(source, { purpose: "monitoring" });
  const facts = sourceBaselineFacts(source);
  const category = categorizeSourceAiCoverage({ source, explanation, factDecision, monitorDecision, facts });
  const action = actionForAiCoverageCategory(category);
  return {
    source_id: source?.id || null,
    award_id: source?.shared_award_id || null,
    award_name: award?.name || null,
    award_status: award?.status || null,
    admin_review_status: source?.admin_review_status || null,
    ai_status: explanation.status,
    ai_complete: explanation.complete,
    needs_ai_review: explanation.needsAiReview || aiReviewCategories.has(category),
    needs_manual_review: explanation.needsManualReview || category === "unclear" || category === "needs_manual_review",
    fact_eligible: factDecision.allowed,
    public_eligible: publicDecision.allowed,
    monitor_eligible: monitorDecision.allowed,
    category,
    planned_action: action.action,
    action_reason: action.reason,
    rejection_reason: explanation.reason,
    source_quality_reason: monitorDecision.allowed ? publicDecision.reason : monitorDecision.reason,
    award_relevance: explanation.awardRelevance,
    cycle_relevance: explanation.cycleRelevance,
    confidence: explanation.confidence,
    quality_flags: explanation.qualityFlags,
    has_page_metadata_generated_at: explanation.hasGeneratedAt,
    has_page_metadata_model: explanation.hasModel,
    has_baseline_facts: explanation.hasBaselineFacts,
    has_baseline_facts_rejected: explanation.hasBaselineFactsRejected,
    has_evidence_quotes: hasEvidenceQuotes(facts),
    raw_award_relevance: cleanText(facts.award_relevance) || null,
    raw_cycle_relevance: cleanText(facts.cycle_relevance) || null,
    page_type: source?.page_type || null,
    title: source?.display_title || source?.title || null,
    url: source?.url || null,
  };
}

export function categorizeSourceAiCoverage({
  source,
  explanation,
  factDecision,
  monitorDecision,
  facts,
}: {
  source: AiCoverageSource;
  explanation: ReturnType<typeof explainSourceAiReviewStatus>;
  factDecision: ReturnType<typeof sourceQualityDecision>;
  monitorDecision: ReturnType<typeof sourceQualityDecision>;
  facts: Record<string, unknown>;
}): AiCoverageCategory {
  const isOpen = source?.admin_review_status === "open";
  const status = explanation.status;
  const qualityCategory = qualityDecisionCategory(source, monitorDecision, explanation);

  if (isOpen && qualityCategory) return qualityCategory;
  if (status === "unreviewed") return needsCaptureBaseline(source, explanation) ? "needs_capture_baseline" : "unreviewed";
  if (status === "review_failed") return "review_failed";
  if (status === "reviewed_invalid_or_incomplete") {
    if (explanation.reason === "missing_cycle_relevance") return "missing_cycle_relevance";
    if (!explanation.hasBaselineFacts && !explanation.hasBaselineFactsRejected) return "needs_capture_baseline";
    return "incomplete_review";
  }
  if (status === "reviewed_unclear_needs_manual_review") return "unclear";
  if (status === "reviewed_rejected_unrelated") return isOpen ? "unrelated_but_open" : "complete_rejected";
  if (status === "reviewed_rejected_sibling_program") return isOpen ? "sibling_but_open" : "complete_rejected";
  if (status === "reviewed_rejected_archived_or_past") return isOpen ? "archived_but_open" : "complete_rejected";
  if (status === "reviewed_rejected_not_program_page") return isOpen ? "not_program_page_but_open" : "complete_rejected";
  if (status === "reviewed_rejected_access_error") return isOpen ? "access_error_but_open" : "complete_rejected";
  if (status === "reviewed_rejected_generic_listing") return isOpen ? "generic_listing_but_open" : "complete_rejected";
  if (status === "reviewed_accepted_primary" || status === "reviewed_accepted_supporting") {
    if (!hasEvidenceQuotes(facts)) return "missing_evidence";
    if (!factDecision.allowed) return qualityCategory || "needs_manual_review";
    return "complete_accepted";
  }
  return explanation.needsManualReview ? "needs_manual_review" : "incomplete_review";
}

export function actionForAiCoverageCategory(category: AiCoverageCategory) {
  if (category === "complete_accepted") return { action: "leave_open", reason: "source_has_complete_clear_ai_review" };
  if (autoReviewLaterCategories.has(category)) return { action: "move_to_review_later", reason: category };
  if (aiReviewCategories.has(category)) return { action: "queue_ai_review", reason: category };
  return { action: "needs_manual_review", reason: category || "unknown" };
}

export function summarizeAiReviewCoverage({
  awards = [],
  rows = [],
  pageAudits = [],
  workerRuns = [],
}: {
  awards?: AiCoverageAward[];
  rows?: SourceAiCoverageRow[];
  pageAudits?: PageAuditLite[];
  workerRuns?: LocalWorkerRun[];
}): AiReviewCoverageSummary {
  const activeAwards = awards.filter((award) => award.status === "active");
  const openRows = rows.filter((row) => row.admin_review_status === "open");
  const reviewLaterRows = rows.filter((row) => row.admin_review_status === "review_later");
  const categoryCounts = countBy(rows, (row) => row.category);
  const openCategoryCounts = countBy(openRows, (row) => row.category);
  const statusCounts = countBy(rows, (row) => row.ai_status);
  const openStatusCounts = countBy(openRows, (row) => row.ai_status);
  const awardsWithPublicFacts = activeAwards.filter((award) => objectHasKeys(award.public_facts));
  const openSourcesByAward = groupBy(openRows, (row) => row.award_id || "");
  const factEligibleByAward = groupBy(openRows.filter((row) => row.fact_eligible), (row) => row.award_id || "");
  const awardsWithNoReviewedOpenSources = activeAwards
    .filter((award) => !(openSourcesByAward.get(award.id) || []).some((row) => row.ai_complete))
    .map(awardSummary);
  const awardsWithUnresolvedSourceFactConflicts = activeAwards
    .filter((award) => {
      const awardRows = openSourcesByAward.get(award.id) || [];
      if (!awardRows.length) return false;
      const hasPublicFacts = objectHasKeys(award.public_facts);
      const hasFactEligible = Boolean(factEligibleByAward.get(award.id)?.length);
      const hasRejectedOrManual = awardRows.some((row) => !row.fact_eligible && row.ai_status !== "unreviewed");
      return (hasPublicFacts && !hasFactEligible) || (hasFactEligible && hasRejectedOrManual);
    })
    .map(awardSummary);
  const latestBackfillRun = latestWorker(
    workerRuns,
    (run) => run.worker_name === "local-open-source-ai-coverage-backfill" || objectValue(run.metadata).kind === "open_source_ai_review_coverage_backfill",
  );
  const latestBaselineFactsWorker = latestWorker(workerRuns, (run) =>
    /baseline.*facts|facts.*baseline/i.test(`${run.worker_name} ${JSON.stringify(run.metadata || {})}`),
  );
  const latestGeminiRun = latestWorker(workerRuns, workerUsesGemini);
  const latestGeminiBlocker = workerHasGeminiBlocker(latestGeminiRun) ? latestGeminiRun : null;
  const criticalPageAuditFailures = pageAudits.filter((audit) =>
    ["failed", "needs-review"].includes(cleanKey(audit.audit_status)) &&
    ["critical", "error"].includes(cleanKey(audit.severity)) &&
    !audit.resolved_at,
  ).length;
  const publicAwardCompleteCount = activeAwards.filter((award) => {
    const awardRows = openSourcesByAward.get(award.id) || [];
    return objectHasKeys(award.public_facts) && awardRows.some((row) => row.fact_eligible);
  }).length;
  const blockerCounts = completionBlockerCounts({
    openRows,
    activeAwards,
    criticalPageAuditFailures,
    billingBlocked: Boolean(latestGeminiBlocker),
  });
  const completionPassed = Object.values(blockerCounts).every((value) => value === 0);

  return {
    total_sources: rows.length,
    open_sources: openRows.length,
    review_later_sources: reviewLaterRows.length,
    sources_with_page_metadata_generated_at: rows.filter((row) => row.has_page_metadata_generated_at).length,
    sources_with_page_metadata_model: rows.filter((row) => row.has_page_metadata_model).length,
    sources_with_baseline_facts: rows.filter((row) => row.has_baseline_facts).length,
    sources_with_baseline_facts_rejected: rows.filter((row) => row.has_baseline_facts_rejected).length,
    unreviewed_open_sources: openRows.filter((row) => row.ai_status === "unreviewed").length,
    open_sources_with_award_relevance_unrelated: openRows.filter((row) => row.award_relevance === "unrelated").length,
    open_sources_with_award_relevance_unclear: openRows.filter((row) => row.award_relevance === "unclear").length,
    open_sources_missing_cycle_relevance: openRows.filter((row) => !row.raw_cycle_relevance && row.has_baseline_facts).length,
    open_sources_with_cycle_relevance_unclear: openRows.filter((row) => row.cycle_relevance === "unclear").length,
    open_sources_with_review_failed_status: openRows.filter((row) => row.ai_status === "review_failed").length,
    open_sources_with_incomplete_or_invalid_metadata: openRows.filter((row) => row.ai_status === "reviewed_invalid_or_incomplete").length,
    fact_eligible_sources: rows.filter((row) => row.fact_eligible).length,
    monitor_eligible_sources: rows.filter((row) => row.monitor_eligible).length,
    public_eligible_sources: rows.filter((row) => row.public_eligible).length,
    active_awards: activeAwards.length,
    awards_with_no_public_facts: activeAwards.filter((award) => !objectHasKeys(award.public_facts)).length,
    awards_with_public_facts: awardsWithPublicFacts.length,
    awards_with_no_reviewed_open_sources: awardsWithNoReviewedOpenSources.length,
    awards_with_unresolved_source_fact_conflicts: awardsWithUnresolvedSourceFactConflicts.length,
    critical_page_audit_failures: criticalPageAuditFailures,
    percent_complete_all_sources: percent(rows.filter((row) => row.ai_complete).length, rows.length),
    percent_complete_open_sources: percent(openRows.filter((row) => row.ai_complete).length, openRows.length),
    percent_complete_public_award_pages: percent(publicAwardCompleteCount, activeAwards.length),
    status_counts: statusCounts,
    open_status_counts: openStatusCounts,
    category_counts: categoryCounts,
    open_category_counts: openCategoryCounts,
    source_quality_rejection_counts: countBy(openRows.filter((row) => !row.monitor_eligible), (row) => row.source_quality_reason),
    latest_backfill_run_status: workerSummary(latestBackfillRun),
    latest_baseline_facts_worker_status: workerSummary(latestBaselineFactsWorker),
    latest_gemini_billing_quota_blocker: workerSummary(latestGeminiBlocker),
    completion_blockers: blockerCounts,
    completion_passed: completionPassed,
    active_open_source_count: openRows.filter((row) => row.award_status === "active").length,
    awards_with_no_reviewed_open_source_examples: awardsWithNoReviewedOpenSources.slice(0, 25),
    unresolved_source_fact_conflict_examples: awardsWithUnresolvedSourceFactConflicts.slice(0, 25),
    problem_source_examples: openRows.filter((row) => hardCompletionBlockerCategories.has(row.category)).slice(0, 25),
  };
}

export function completionBlockerCounts({
  openRows = [],
  activeAwards = [],
  criticalPageAuditFailures = 0,
  billingBlocked = false,
}: {
  openRows?: SourceAiCoverageRow[];
  activeAwards?: AiCoverageAward[];
  criticalPageAuditFailures?: number;
  billingBlocked?: boolean;
}) {
  return {
    open_unreviewed: openRows.filter((row) => row.ai_status === "unreviewed").length,
    open_unrelated: openRows.filter((row) => row.category === "unrelated_but_open").length,
    open_unclear: openRows.filter((row) => row.category === "unclear" || row.category === "needs_manual_review").length,
    open_sibling: openRows.filter((row) => row.category === "sibling_but_open").length,
    open_not_program_page: openRows.filter((row) => row.category === "not_program_page_but_open").length,
    open_access_error: openRows.filter((row) => row.category === "access_error_but_open").length,
    open_missing_cycle_relevance: openRows.filter((row) => row.category === "missing_cycle_relevance").length,
    open_missing_evidence: openRows.filter((row) => row.category === "missing_evidence").length,
    public_awards_missing_facts: activeAwards.filter((award) => !objectHasKeys(award.public_facts)).length,
    critical_page_audit_failures: criticalPageAuditFailures,
    gemini_billing_blocked: billingBlocked ? 1 : 0,
  };
}

export function workerHasGeminiBlocker(run: LocalWorkerRun | null | undefined) {
  if (!run) return false;
  const metadata = objectValue(run.metadata);
  if (metadata.billing_blocked === true) return true;
  const reason = cleanText(
    metadata.blocking_reason || metadata.billing_error || metadata.provider_error,
  );
  const error = cleanText(run.error);
  const text = `${error} ${reason}`.toLowerCase();
  if (!text) return false;
  return /\b(billing|quota|prepay|prepayment|credits?\s+are\s+depleted|resource_exhausted)\b/.test(
    text,
  );
}

export function workerUsesGemini(run: LocalWorkerRun | null | undefined) {
  if (!run) return false;
  if (cleanKey(run.ai_provider) === "gemini") return true;
  const metadata = objectValue(run.metadata);
  return /\bgemini\b/i.test(
    `${run.worker_name || ""} ${run.error || ""} ${metadata.ai_provider || ""} ${metadata.ai_model || ""} ${metadata.blocking_reason || ""}`,
  );
}

export function latestWorker(rows: LocalWorkerRun[], predicate: (run: LocalWorkerRun) => boolean) {
  return (rows || []).find(predicate) || null;
}

export function countBy<T>(rows: T[], picker: (row: T) => unknown) {
  const counts: Record<string, number> = {};
  for (const row of rows || []) {
    const key = cleanText(picker(row)) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(sortedEntries(counts));
}

function qualityDecisionCategory(
  source: AiCoverageSource,
  monitorDecision: ReturnType<typeof sourceQualityDecision>,
  explanation: ReturnType<typeof explainSourceAiReviewStatus>,
): AiCoverageCategory | null {
  if (monitorDecision.allowed) return null;
  const reason = cleanKey(monitorDecision.reason);
  const flags = new Set((explanation.qualityFlags || []).map(cleanKey));
  const signal = `${reason} ${(source?.url || "")} ${(source?.title || "")} ${(source?.display_title || "")}`.toLowerCase();
  if (flags.has("sibling-program") || flags.has("unrelated-program") || /sibling|unrelated-program/.test(signal)) return "sibling_but_open";
  if (flags.has("access-error") || /access|captcha|security|login/.test(signal)) return "access_error_but_open";
  if (flags.has("generic-listing") || flags.has("search-results") || flags.has("job-board") || flags.has("career-page")) return "generic_listing_but_open";
  if (/generic|listing|search|career|job|payment|bursar|profile|recipient|news|event|url-not-monitorable/.test(signal)) return "generic_listing_but_open";
  if (/archived|past/.test(signal)) return "archived_but_open";
  if (/not-program/.test(signal)) return "not_program_page_but_open";
  if (/unrelated/.test(signal)) return "unrelated_but_open";
  return null;
}

function needsCaptureBaseline(source: AiCoverageSource, explanation: ReturnType<typeof explainSourceAiReviewStatus>) {
  const metadata = objectValue(source?.page_metadata);
  return !explanation.hasGeneratedAt && !explanation.hasBaselineFacts && !source?.last_checked_at && !metadata.final_url && !metadata.snapshot_hash;
}

function hasEvidenceQuotes(facts: Record<string, unknown>) {
  const evidence = facts?.evidence_quotes;
  if (Array.isArray(evidence)) return evidence.some((quote) => cleanText(quote));
  return Boolean(cleanText(evidence));
}

function workerSummary(run: LocalWorkerRun | null): WorkerSummary {
  if (!run) return null;
  const metadata = objectValue(run.metadata);
  return {
    id: run.id,
    worker_name: run.worker_name,
    status: run.status,
    ai_provider: run.ai_provider,
    checked_count: run.checked_count,
    changed_count: run.changed_count,
    failed_count: run.failed_count,
    started_at: run.started_at,
    finished_at: run.finished_at,
    error: run.error,
    billing_blocked: Boolean(metadata.billing_blocked),
    blocking_reason: cleanText(metadata.blocking_reason || metadata.stop_reason) || null,
  };
}

async function loadAiCoverageAwards(admin: AdminClient, loadErrors: string[]) {
  const awards: AiCoverageAward[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("shared_awards")
      .select("id,name,slug,status,public_facts")
      .range(from, from + 999);
    if (error) {
      loadErrors.push(error.message);
      break;
    }
    const rows = (data || []) as AiCoverageAward[];
    awards.push(...rows);
    if (rows.length < 1000) break;
  }
  return awards;
}

async function loadAiCoverageSources(admin: AdminClient, loadErrors: string[], maxRows = Number.POSITIVE_INFINITY) {
  const sources: AiCoverageSource[] = [];
  for (let from = 0; sources.length < maxRows; from += 1000) {
    const pageSize = Math.min(1000, maxRows - sources.length);
    const { data, error } = await admin
      .from("shared_award_sources")
      .select(
        "id,shared_award_id,url,title,display_title,page_description,page_metadata,page_metadata_generated_at,page_metadata_model,page_type,source,reason,submitted_by_user_id,admin_review_status,last_checked_at,last_error,created_at",
      )
      .range(from, from + pageSize - 1);
    if (error) {
      loadErrors.push(error.message);
      break;
    }
    const rows = (data || []) as unknown as AiCoverageSource[];
    sources.push(...rows);
    if (rows.length < pageSize) break;
  }
  return sources;
}

function reportOpenCategoryCounts(
  sourceSummary: Record<string, unknown>,
  counts: Record<string, unknown>,
): Record<string, number> {
  const fromSummary = normalizeNumberRecord(objectValue(sourceSummary.open_category_counts));
  if (Object.keys(fromSummary).length > 0) return fromSummary;
  return normalizeNumberRecord({
    complete_accepted: counts.complete_accepted,
    complete_rejected: counts.complete_rejected,
    unreviewed: counts.unreviewed,
    incomplete_review: counts.incomplete_review,
    unclear: counts.unclear,
    unrelated_but_open: counts.unrelated_but_open,
    sibling_but_open: counts.sibling_but_open,
    missing_cycle_relevance: counts.missing_cycle_relevance,
    review_failed: counts.review_failed,
  });
}

function reportCategoryCounts(
  sourceSummary: Record<string, unknown>,
  counts: Record<string, unknown>,
  fallback: Record<string, number>,
): Record<string, number> {
  const fromSummary = normalizeNumberRecord(objectValue(sourceSummary.category_counts));
  if (Object.keys(fromSummary).length > 0) return fromSummary;
  return Object.keys(fallback).length > 0 ? fallback : normalizeNumberRecord(counts);
}

function reportCompletionBlockers(
  sourceSummary: Record<string, unknown>,
  counts: Record<string, unknown>,
  blockers: Record<string, unknown>,
  billingBlocked: boolean,
): Record<string, number> {
  const fromSummary = normalizeNumberRecord(blockers);
  return {
    open_unreviewed: numberValue(fromSummary.open_unreviewed ?? counts.unreviewed),
    open_unrelated: numberValue(fromSummary.open_unrelated ?? counts.unrelated_but_open),
    open_unclear: numberValue(fromSummary.open_unclear ?? counts.unclear),
    open_sibling: numberValue(fromSummary.open_sibling ?? counts.sibling_but_open),
    open_not_program_page: numberValue(fromSummary.open_not_program_page ?? counts.not_program_page_but_open),
    open_access_error: numberValue(fromSummary.open_access_error ?? counts.access_error_but_open),
    open_missing_cycle_relevance: numberValue(fromSummary.open_missing_cycle_relevance ?? counts.missing_cycle_relevance),
    open_missing_evidence: numberValue(fromSummary.open_missing_evidence ?? counts.missing_evidence),
    public_awards_missing_facts: numberValue(fromSummary.public_awards_missing_facts ?? sourceSummary.awards_with_no_public_facts),
    critical_page_audit_failures: numberValue(fromSummary.critical_page_audit_failures ?? sourceSummary.critical_page_audit_failures),
    gemini_billing_blocked: billingBlocked ? 1 : numberValue(fromSummary.gemini_billing_blocked),
  };
}

function normalizeNumberRecord(value: Record<string, unknown>): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value || {})) {
    const number = nullableNumber(rawValue);
    if (number !== null) normalized[key] = number;
  }
  return Object.fromEntries(sortedEntries(normalized));
}

async function loadPageAuditLites(admin: AdminClient, warnings: string[], loadErrors: string[]) {
  const rawAdmin = admin as unknown as SupabaseClient;
  const { data, error } = await rawAdmin
    .from("shared_award_page_audits")
    .select("audit_status,severity,resolved_at")
    .limit(5000);
  if (error?.message) {
    if (isMissingRelationError(error.message)) {
      warnings.push("Page audit table is not configured yet.");
      return [];
    }
    loadErrors.push(error.message);
    return [];
  }
  return (data || []) as PageAuditLite[];
}

function groupBy<T>(rows: T[], picker: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows || []) {
    const key = picker(row);
    const current = grouped.get(key);
    if (current) current.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

function awardSummary(award: AiCoverageAward) {
  return {
    award_id: award.id,
    award_name: award.name,
    slug: award.slug || null,
  };
}

function objectHasKeys(value: unknown) {
  return Object.keys(objectValue(value)).length > 0;
}

function sortedEntries(value: Record<string, number>) {
  return Object.entries(value || {}).sort((left, right) => {
    const countDelta = Number(right[1]) - Number(left[1]);
    return countDelta || String(left[0]).localeCompare(String(right[0]));
  });
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

function cleanKey(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function percent(numerator: number, denominator: number) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
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

function positiveIntegerFromEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
