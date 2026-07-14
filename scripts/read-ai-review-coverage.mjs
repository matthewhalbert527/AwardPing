#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildSourceAiCoverageRow,
  cleanText,
  objectValue,
  sortedEntries,
  summarizeAiReviewCoverage,
} from "./lib/ai-review-coverage.mjs";
import {
  applyAscendingAwardKeyset,
  awardCursorAfterPage,
} from "./lib/award-keyset-pagination.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
if (boolArg(args.help, false)) {
  printHelp();
  process.exit(0);
}

const envPath = args.env
  ? resolve(root, String(args.env))
  : existsSync(resolve(root, ".env.worker.local"))
    ? resolve(root, ".env.worker.local")
    : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const outputJson = boolArg(args.json, false);
const outputCsv = boolArg(args.csv, false);
const onlyOpen = boolArg(args["only-open"], false);
const onlyPublicAwards = boolArg(args["only-public-awards"], false);
const awardIdFilter = cleanText(args["award-id"]);
const sourceIdFilter = cleanText(args["source-id"]);
const statusFilter = cleanText(args.status);
const categoryFilter = cleanText(args.category);
const limit = nonNegativeInt(args.limit, 0);
const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);

const [awards, sources, pageAudits, workerRuns] = await Promise.all([
  loadAwards(),
  loadSources(),
  loadLatestPageAudits(),
  loadLatestWorkerRuns(),
]);
const awardById = new Map(awards.map((award) => [award.id, award]));
const sourceRows = sources
  .filter((source) => !onlyOpen || source.admin_review_status === "open")
  .filter((source) => !onlyPublicAwards || awardById.get(source.shared_award_id)?.status === "active")
  .filter((source) => !awardIdFilter || source.shared_award_id === awardIdFilter)
  .filter((source) => !sourceIdFilter || source.id === sourceIdFilter)
  .map((source) => buildSourceAiCoverageRow(source, awardById.get(source.shared_award_id) || null))
  .filter((row) => !statusFilter || row.ai_status === statusFilter)
  .filter((row) => !categoryFilter || row.category === categoryFilter);

const displayedRows = limit > 0 ? sourceRows.slice(0, limit) : sourceRows;
const summary = summarizeAiReviewCoverage({ awards, rows: sourceRows, pageAudits: pageAudits.rows, workerRuns: workerRuns.rows });
const report = {
  generated_at: new Date().toISOString(),
  env_path: envPath,
  filters: {
    only_open: onlyOpen,
    only_public_awards: onlyPublicAwards,
    award_id: awardIdFilter || null,
    source_id: sourceIdFilter || null,
    status: statusFilter || null,
    category: categoryFilter || null,
    limit: limit || null,
  },
  summary: {
    ...summary,
    page_audit_load_error: pageAudits.error,
    worker_load_error: workerRuns.error,
  },
  recommended_commands: recommendedCommands(summary),
  rows: displayedRows,
};

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
} else if (outputCsv) {
  printCsv(displayedRows);
} else {
  printHuman(report);
}

async function loadAwards() {
  const rows = [];
  const pageSize = 1000;
  let cursor = null;
  for (;;) {
    let query = supabase
      .from("shared_awards")
      .select("id,name,slug,status,public_facts,public_facts_generated_at");
    if (awardIdFilter) query = query.eq("id", awardIdFilter);
    if (onlyPublicAwards) query = query.eq("status", "active");
    query = applyAscendingAwardKeyset(query, "name", cursor).limit(pageSize);
    const { data, error } = await query;
    if (error) throw new Error(`Load shared awards failed: ${error.message}`);
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
    cursor = awardCursorAfterPage(page, "name", cursor);
  }
  return rows;
}

async function loadSources() {
  const rows = [];
  let cursor = null;
  for (;;) {
    let query = supabase
      .from("shared_award_sources")
      .select(
        "id,shared_award_id,url,title,display_title,page_description,page_metadata,page_metadata_generated_at,page_metadata_model,page_type,source,reason,submitted_by_user_id,admin_review_status,last_checked_at,last_error,created_at",
      )
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1000);
    if (awardIdFilter) query = query.eq("shared_award_id", awardIdFilter);
    if (sourceIdFilter) query = query.eq("id", sourceIdFilter);
    if (onlyOpen) query = query.eq("admin_review_status", "open");
    if (cursor) {
      const createdAt = JSON.stringify(cursor.createdAt);
      query = query.or(
        `created_at.gt.${createdAt},and(created_at.eq.${createdAt},id.gt.${cursor.id})`,
      );
    }
    const { data, error } = await query;
    if (error) throw new Error(`Load shared award sources failed: ${error.message}`);
    const page = data || [];
    rows.push(...page);
    if (page.length < 1000) break;
    const last = page.at(-1);
    cursor = { createdAt: last.created_at, id: last.id };
  }
  return rows;
}

async function loadLatestPageAudits() {
  const { data, error } = await supabase
    .from("shared_award_page_audits")
    .select("id,shared_award_id,audit_status,severity,resolved_at,created_at")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) {
    if (isMissingTableOrColumnError(error)) return { rows: [], error: error.message };
    return { rows: [], error: error.message };
  }
  return { rows: data || [], error: null };
}

async function loadLatestWorkerRuns() {
  const { data, error } = await supabase
    .from("local_worker_runs")
    .select("id,worker_name,status,ai_provider,checked_count,changed_count,failed_count,error,metadata,started_at,finished_at")
    .order("started_at", { ascending: false })
    .limit(150);
  if (error) return { rows: [], error: error.message };
  return { rows: data || [], error: null };
}

function recommendedCommands(summary) {
  const applyCommand = "node scripts/backfill-open-source-ai-determinations.mjs --apply=true --max-batch-requests=500 --reconcile=true";
  const dryRunCommand = "node scripts/backfill-open-source-ai-determinations.mjs --dry-run=true --json";
  return {
    dry_run: dryRunCommand,
    apply: applyCommand,
    resume_after_billing_fix: applyCommand,
    reconcile_only: "node scripts/reconcile-impacted-award-pages.mjs --apply=true --only-pending=true --limit=500",
    coverage_passed: summary.completion_passed,
  };
}

function printHuman(report) {
  const summary = report.summary;
  console.log("AI Review Coverage");
  console.log(`Generated: ${report.generated_at}`);
  console.log(`Completion: ${summary.completion_passed ? "PASS" : "FAIL"}`);
  console.log(`Sources: total=${summary.total_sources} open=${summary.open_sources} review_later=${summary.review_later_sources}`);
  console.log(
    `Reviewed metadata: generated_at=${summary.sources_with_page_metadata_generated_at} model=${summary.sources_with_page_metadata_model} facts=${summary.sources_with_baseline_facts} rejected=${summary.sources_with_baseline_facts_rejected}`,
  );
  console.log(
    `Eligible: monitor=${summary.monitor_eligible_sources} public=${summary.public_eligible_sources} facts=${summary.fact_eligible_sources}`,
  );
  console.log(
    `Open problems: unreviewed=${summary.unreviewed_open_sources} unrelated=${summary.open_sources_with_award_relevance_unrelated} unclear=${summary.open_sources_with_award_relevance_unclear} missing_cycle=${summary.open_sources_missing_cycle_relevance} failed=${summary.open_sources_with_review_failed_status} invalid=${summary.open_sources_with_incomplete_or_invalid_metadata}`,
  );
  console.log(
    `Completeness: all=${summary.percent_complete_all_sources}% open=${summary.percent_complete_open_sources}% public_pages=${summary.percent_complete_public_award_pages}%`,
  );
  console.log(`Awards: active=${summary.active_awards} no_public_facts=${summary.awards_with_no_public_facts} no_reviewed_open_sources=${summary.awards_with_no_reviewed_open_sources} unresolved_conflicts=${summary.awards_with_unresolved_source_fact_conflicts} critical_audits=${summary.critical_page_audit_failures}`);
  console.log("Completion blockers:");
  for (const [key, value] of Object.entries(summary.completion_blockers || {})) {
    if (value) console.log(`  ${key}: ${value}`);
  }
  if (summary.latest_backfill_run_status) {
    const worker = summary.latest_backfill_run_status;
    console.log(`Latest AI coverage backfill: ${worker.status} started=${worker.started_at} error=${worker.error || "none"}`);
  }
  if (summary.latest_baseline_facts_worker_status) {
    const worker = summary.latest_baseline_facts_worker_status;
    console.log(`Latest baseline worker: ${worker.status} ${worker.worker_name} started=${worker.started_at} error=${worker.error || "none"}`);
  }
  if (summary.latest_gemini_billing_quota_blocker) {
    const worker = summary.latest_gemini_billing_quota_blocker;
    console.log(`Gemini blocker: ${worker.status} ${worker.started_at} reason=${worker.blocking_reason || worker.error || "reported"}`);
  }
  if (Object.keys(summary.open_category_counts).length) {
    console.log("Open coverage categories:");
    for (const [status, count] of sortedEntries(summary.open_category_counts)) {
      console.log(`  ${status}: ${count}`);
    }
  }
  if (Object.keys(summary.open_status_counts).length) {
    console.log("Open AI status counts:");
    for (const [status, count] of sortedEntries(summary.open_status_counts)) {
      console.log(`  ${status}: ${count}`);
    }
  }
  if (Object.keys(summary.source_quality_rejection_counts).length) {
    console.log("Open monitor rejection counts:");
    for (const [reason, count] of sortedEntries(summary.source_quality_rejection_counts)) {
      console.log(`  ${reason}: ${count}`);
    }
  }
  console.log(`Backfill dry run: ${report.recommended_commands.dry_run}`);
  console.log(`Backfill apply: ${report.recommended_commands.apply}`);
  if (summary.problem_source_examples.length) {
    console.log("Problem source examples:");
    for (const row of summary.problem_source_examples.slice(0, 10)) {
      console.log(`  ${row.category} | ${row.award_name || row.award_id} | ${row.title || "Untitled"} | ${row.url}`);
    }
  }
  if (summary.page_audit_load_error) console.log(`Page audit warning: ${summary.page_audit_load_error}`);
  if (summary.worker_load_error) console.log(`Worker run warning: ${summary.worker_load_error}`);
}

function printCsv(rows) {
  const columns = [
    "source_id",
    "award_id",
    "award_name",
    "admin_review_status",
    "category",
    "planned_action",
    "ai_status",
    "ai_complete",
    "fact_eligible",
    "public_eligible",
    "monitor_eligible",
    "rejection_reason",
    "source_quality_reason",
    "award_relevance",
    "cycle_relevance",
    "confidence",
    "title",
    "url",
  ];
  console.log(columns.join(","));
  for (const row of rows) {
    console.log(columns.map((column) => csvCell(row[column])).join(","));
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) {
      parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[withoutPrefix] = next;
      index += 1;
    } else {
      parsed[withoutPrefix] = "true";
    }
  }
  return parsed;
}

function loadEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(value));
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function isMissingTableOrColumnError(error) {
  const message = error?.message || "";
  return /does not exist|schema cache|relation .* not found|column .* does not exist/i.test(message);
}

function csvCell(value) {
  if (Array.isArray(value)) return csvCell(value.join("|"));
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return csvCell(JSON.stringify(objectValue(value)));
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function printHelp() {
  console.log(`Usage: node scripts/read-ai-review-coverage.mjs [options]

Reports canonical Gemini/AI source review coverage and the hard completion blockers.

Options:
  --json                         Print JSON report
  --csv                          Print source rows as CSV
  --only-open=true               Include only open sources
  --only-public-awards=true      Include only active/public awards
  --award-id=<uuid>              Filter to one award
  --source-id=<uuid>             Filter to one source
  --status=<status>              Filter rows by canonical AI review status
  --category=<category>          Filter rows by completion category
  --limit=<n>                    Limit printed rows for JSON/CSV detail
  --env=<path>                   Env file path (defaults .env.worker.local, then .env.local)
`);
}
