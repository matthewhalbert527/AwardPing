import { explainSourceAiReviewStatus, sourceBaselineFacts } from "./source-ai-review-status.mjs";
import { sourceQualityDecision } from "./source-quality.mjs";

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
];

const autoReviewLaterCategories = new Set([
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

const aiReviewCategories = new Set([
  "unreviewed",
  "incomplete_review",
  "missing_cycle_relevance",
  "missing_evidence",
  "needs_capture_baseline",
  "review_failed",
]);

const hardCompletionBlockerCategories = new Set([
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

export function buildSourceAiCoverageRow(source, award = null) {
  const explanation = explainSourceAiReviewStatus(source);
  const factDecision = sourceQualityDecision(source, { purpose: "facts" });
  const publicDecision = sourceQualityDecision(source, { purpose: "public" });
  const monitorDecision = sourceQualityDecision(source, { purpose: "monitoring" });
  const facts = sourceBaselineFacts(source);
  const category = categorizeSourceAiCoverage({ source, explanation, factDecision, publicDecision, monitorDecision, facts });
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

export function categorizeSourceAiCoverage({ source, explanation, factDecision, monitorDecision, facts }) {
  const adminStatus = source?.admin_review_status || null;
  const isOpen = adminStatus === "open";
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

export function actionForAiCoverageCategory(category) {
  if (category === "complete_accepted") return { action: "leave_open", reason: "source_has_complete_clear_ai_review" };
  if (autoReviewLaterCategories.has(category)) return { action: "move_to_review_later", reason: category };
  if (aiReviewCategories.has(category)) return { action: "queue_ai_review", reason: category };
  return { action: "needs_manual_review", reason: category || "unknown" };
}

export function summarizeAiReviewCoverage({ awards = [], rows = [], pageAudits = [], workerRuns = [] }) {
  const activeAwards = awards.filter((award) => award.status === "active");
  const openRows = rows.filter((row) => row.admin_review_status === "open");
  const reviewLaterRows = rows.filter((row) => row.admin_review_status === "review_later");
  const categoryCounts = countBy(rows, (row) => row.category);
  const openCategoryCounts = countBy(openRows, (row) => row.category);
  const statusCounts = countBy(rows, (row) => row.ai_status);
  const openStatusCounts = countBy(openRows, (row) => row.ai_status);
  const awardsWithPublicFacts = activeAwards.filter((award) => objectHasKeys(award.public_facts));
  const openSourcesByAward = groupBy(openRows, (row) => row.award_id);
  const factEligibleByAward = groupBy(openRows.filter((row) => row.fact_eligible), (row) => row.award_id);
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
  const latestBackfillRun = latestWorker(workerRuns, (run) => run.worker_name === "local-open-source-ai-coverage-backfill" || objectValue(run.metadata).kind === "open_source_ai_review_coverage_backfill");
  const latestBaselineFactsWorker = latestWorker(
    workerRuns,
    (run) => /baseline.*facts|facts.*baseline/i.test(`${run.worker_name} ${JSON.stringify(run.metadata || {})}`),
  );
  const latestGeminiBlocker = latestWorker(workerRuns, workerHasGeminiBlocker);
  const criticalPageAuditFailures = pageAudits.filter((audit) =>
    ["failed", "needs_review"].includes(cleanKey(audit.audit_status)) &&
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

export function completionBlockerCounts({ openRows = [], activeAwards = [], criticalPageAuditFailures = 0, billingBlocked = false }) {
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

export function workerHasGeminiBlocker(run) {
  const text = `${run?.error || ""} ${JSON.stringify(run?.metadata || {})}`.toLowerCase();
  return /\b(gemini|google ai)\b/.test(text) && /\b(billing|quota|prepay|prepayment|credits?\s+are\s+depleted|resource_exhausted|blocked)\b/.test(text);
}

export function latestWorker(rows, predicate) {
  return (rows || []).find(predicate) || null;
}

export function countBy(rows, picker) {
  const counts = {};
  for (const row of rows || []) {
    const key = cleanText(picker(row)) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(sortedEntries(counts));
}

export function sortedEntries(value) {
  return Object.entries(value || {}).sort((left, right) => {
    const countDelta = Number(right[1]) - Number(left[1]);
    return countDelta || String(left[0]).localeCompare(String(right[0]));
  });
}

export function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function qualityDecisionCategory(source, monitorDecision, explanation) {
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

function needsCaptureBaseline(source, explanation) {
  const metadata = objectValue(source?.page_metadata);
  return !explanation.hasGeneratedAt && !explanation.hasBaselineFacts && !source?.last_checked_at && !metadata.final_url && !metadata.snapshot_hash;
}

function hasEvidenceQuotes(facts) {
  const evidence = facts?.evidence_quotes;
  if (Array.isArray(evidence)) return evidence.some((quote) => cleanText(quote));
  return Boolean(cleanText(evidence));
}

function workerSummary(run) {
  if (!run) return null;
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
    billing_blocked: Boolean(objectValue(run.metadata).billing_blocked),
    blocking_reason: cleanText(objectValue(run.metadata).blocking_reason || objectValue(run.metadata).stop_reason) || null,
  };
}

function groupBy(rows, picker) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = picker(row);
    const current = grouped.get(key);
    if (current) current.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

function awardSummary(award) {
  return {
    award_id: award.id,
    award_name: award.name,
    slug: award.slug || null,
  };
}

function objectHasKeys(value) {
  return Object.keys(objectValue(value)).length > 0;
}

function cleanKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function percent(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}
