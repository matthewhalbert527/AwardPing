#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  auditPublicAwardPage,
  buildAwardSummaryFromFacts,
  buildFactCandidatesFromSources,
  preserveLastKnownGoodAmountFacts,
  reconcileAwardFacts,
} from "./lib/award-fact-reconciliation.mjs";
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
const env = { ...loadEnvFile(envPath), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const limit = positiveInt(args.limit, 250);
const awardIdFilter = cleanNullable(args["award-id"]);
const slugFilter = cleanNullable(args.slug);
const onlyPending = boolArg(args["only-pending"], !awardIdFilter && !slugFilter);
const onlyFailed = boolArg(args["only-failed"], false);
const dryRun = boolArg(args["dry-run"], !boolArg(args.apply, false));
const apply = boolArg(args.apply, !dryRun);
const includeWarnings = boolArg(args["include-warnings"], true);
const processingTimeoutMinutes = positiveInt(args["processing-timeout-minutes"], 45);
const json = boolArg(args.json, false);
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(reportDir, `award-page-reconciliation-${timestampForPath(new Date().toISOString())}.json`);

const report = {
  started_at: new Date().toISOString(),
  finished_at: null,
  status: "running",
  env_path: envPath,
  report_path: reportPath,
  options: {
    limit,
    award_id: awardIdFilter,
    slug: slugFilter,
    only_pending: onlyPending,
    only_failed: onlyFailed,
    dry_run: dryRun,
    apply,
    include_warnings: includeWarnings,
    processing_timeout_minutes: processingTimeoutMinutes,
  },
  queue_rows_loaded: 0,
  awards_checked: 0,
  awards_reconciled: 0,
  awards_audit_passed: 0,
  awards_audit_warnings: 0,
  awards_audit_failed: 0,
  awards_publication_blocked: 0,
  awards_used_last_known_good: 0,
  awards_amounts_preserved_for_review: 0,
  sibling_sources_rejected: 0,
  deadline_conflicts_detected: 0,
  stale_cycle_states_corrected: 0,
  facts_published: 0,
  facts_dry_run: 0,
  candidate_rows_loaded: 0,
  generated_candidates: 0,
  selected_candidates: 0,
  rejected_candidates: 0,
  source_rejections: 0,
  stale_processing_rows_requeued: 0,
  errors: [],
  awards: [],
};

mkdirSync(reportDir, { recursive: true });
writeReport();

try {
  const queueRows = await targetQueueRows();
  report.queue_rows_loaded = queueRows.length;
  for (const queueRow of queueRows.slice(0, limit)) {
    await processQueueRow(queueRow);
    writeReport();
  }
  report.status = report.errors.length ? "completed_with_errors" : "succeeded";
} catch (error) {
  report.status = "failed";
  report.errors.push({ message: errorMessage(error) });
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  writeReport();
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(`AWARD_RECONCILIATION_REPORT ${reportPath}`);
}

async function targetQueueRows() {
  if (awardIdFilter || slugFilter) {
    const award = awardIdFilter ? await loadAwardById(awardIdFilter) : await loadAwardBySlug(slugFilter);
    if (!award) return [];
    return [{
      id: null,
      shared_award_id: award.id,
      reason: awardIdFilter ? "manual_award_id" : "manual_slug",
      status: "pending",
      metadata: {},
    }];
  }

  if (apply && onlyPending) await recoverStaleProcessingQueueRows();

  let query = supabase
    .from("shared_award_reconciliation_queue")
    .select("*")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(limit);
  if (onlyFailed) query = query.eq("status", "failed");
  else if (onlyPending) query = query.eq("status", "pending");
  const { data, error } = await query;
  if (error) {
    if (isMissingTableError(error)) {
      report.errors.push({ message: "shared_award_reconciliation_queue is not configured yet." });
      return [];
    }
    throw new Error(`Load reconciliation queue failed: ${error.message}`);
  }
  return data || [];
}

async function recoverStaleProcessingQueueRows() {
  const cutoff = new Date(Date.now() - processingTimeoutMinutes * 60_000).toISOString();
  const { data, error } = await supabase
    .from("shared_award_reconciliation_queue")
    .update({
      status: "pending",
      started_at: null,
      completed_at: null,
      error: "requeued_after_stale_processing_timeout",
    })
    .eq("status", "processing")
    .lt("started_at", cutoff)
    .select("id");
  if (error) {
    if (isMissingTableError(error)) return;
    throw new Error(`Recover stale reconciliation rows failed: ${error.message}`);
  }
  report.stale_processing_rows_requeued = (data || []).length;
}

async function processQueueRow(queueRow) {
  const startedAt = new Date().toISOString();
  if (apply && queueRow.id) await updateQueue(queueRow.id, { status: "processing", started_at: startedAt, error: null });

  try {
    const award = await loadAwardById(queueRow.shared_award_id);
    if (!award) {
      if (apply && queueRow.id) await updateQueue(queueRow.id, { status: "skipped", completed_at: new Date().toISOString(), error: "award_not_found" });
      return;
    }

    report.awards_checked += 1;
    const sources = await loadAwardSources(award.id);
    const loadedCandidates = await loadAwardFactCandidates(award.id);
    const candidates = loadedCandidates.length ? loadedCandidates : buildFactCandidatesFromSources(award, sources);
    if (!loadedCandidates.length) report.generated_candidates += candidates.length;
    const reconciliation = reconcileAwardFacts(award, sources, candidates, { now: new Date() });
    const audit = auditPublicAwardPage(award, reconciliation.selectedFacts, sources, { reconciliation, now: new Date() });
    const publishableFacts = preserveLastKnownGoodAmountFacts(reconciliation.selectedFacts, award.public_facts);
    const preservedAmountFields = (publishableFacts.reconciliation.preserved_fields || [])
      .filter((field) => ["award_amounts", "stipend", "travel_research_allowance"].includes(field));
    const amountPreservedForReview = preservedAmountFields.length > 0;
    const shouldPublish = !audit.should_block_publication && (audit.audit_status === "passed" || includeWarnings);
    const conflictFields = new Set(reconciliation.conflicts.map((conflict) => conflict.field_name));

    report.selected_candidates += Object.keys(reconciliation.selected).length;
    report.rejected_candidates += reconciliation.rejected.length;
    report.source_rejections += reconciliation.sourceRejections.length;
    report.sibling_sources_rejected += reconciliation.rejected.filter((item) => item.reason.includes("sibling")).length;
    report.deadline_conflicts_detected += reconciliation.conflicts.filter((conflict) => conflict.field_name === "deadline").length;
    report.stale_cycle_states_corrected += reconciliation.selectedFacts.cycle_status === "deadline_passed" ? 1 : 0;
    if (audit.audit_status === "passed") report.awards_audit_passed += 1;
    else if (audit.audit_status === "warnings") report.awards_audit_warnings += 1;
    else report.awards_audit_failed += 1;

    const awardSummary = {
      award_id: award.id,
      award_name: award.name,
      queue_reason: queueRow.reason,
      source_count: sources.length,
      candidate_count: candidates.length,
      selected_count: Object.keys(reconciliation.selected).length,
      rejected_count: reconciliation.rejected.length,
      conflicts: reconciliation.conflicts.map((conflict) => ({ field_name: conflict.field_name, severity: conflict.severity, reason: conflict.reason })),
      audit_status: audit.audit_status,
      severity: audit.severity,
      findings: audit.findings,
      amount_preserved_for_review: amountPreservedForReview,
      preserved_amount_fields: preservedAmountFields,
      published: false,
      blocked: audit.should_block_publication,
    };
    report.awards.push(awardSummary);

    if (apply) {
      await persistAudit(award, audit, publishableFacts);
      if (loadedCandidates.length) await updateCandidateStatuses(reconciliation, conflictFields);
    }

    if (shouldPublish) {
      report.awards_reconciled += 1;
      if (amountPreservedForReview) report.awards_amounts_preserved_for_review += 1;
      if (apply) {
        await publishAwardFacts(award, publishableFacts);
        awardSummary.published = true;
        report.facts_published += 1;
      } else {
        report.facts_dry_run += 1;
      }
      if (apply && queueRow.id) await updateQueue(queueRow.id, { status: "succeeded", completed_at: new Date().toISOString(), error: null });
    } else {
      report.awards_publication_blocked += 1;
      report.awards_used_last_known_good += 1;
      if (apply && queueRow.id) await updateQueue(queueRow.id, { status: "failed", completed_at: new Date().toISOString(), error: `audit_${audit.audit_status}_${audit.severity}` });
    }
  } catch (error) {
    report.errors.push({ award_id: queueRow.shared_award_id, message: errorMessage(error) });
    if (apply && queueRow.id) await updateQueue(queueRow.id, { status: "failed", completed_at: new Date().toISOString(), error: errorMessage(error).slice(0, 1000) });
  }
}

async function loadAwardById(id) {
  const { data, error } = await supabase
    .from("shared_awards")
    .select("id,name,slug,official_homepage,summary,public_facts,status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Load award failed: ${error.message}`);
  return data;
}

async function loadAwardBySlug(slug) {
  const { data, error } = await supabase
    .from("shared_awards")
    .select("id,name,slug,official_homepage,summary,public_facts,status")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`Load award by slug failed: ${error.message}`);
  return data;
}

async function loadAwardSources(awardId) {
  const { data, error } = await supabase
    .from("shared_award_sources")
    .select("id,shared_award_id,url,title,display_title,page_description,page_type,source,reason,submitted_by_user_id,admin_review_status,page_metadata,page_metadata_generated_at,page_metadata_model,confidence")
    .eq("shared_award_id", awardId)
    .eq("admin_review_status", "open")
    .order("page_type", { ascending: true });
  if (error) throw new Error(`Load award sources failed: ${error.message}`);
  return data || [];
}

async function loadAwardFactCandidates(awardId) {
  const { data, error } = await supabase
    .from("shared_award_fact_candidates")
    .select("*")
    .eq("shared_award_id", awardId)
    .in("candidate_status", ["pending", "selected", "conflicted"])
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Load fact candidates failed: ${error.message}`);
  }
  report.candidate_rows_loaded += (data || []).length;
  return (data || []).map((row) => ({
    ...row,
    raw_value: rawValueFromCandidateRow(row),
  }));
}

function rawValueFromCandidateRow(row) {
  if (row.normalized_value !== null && row.normalized_value !== undefined) return row.normalized_value;
  return row.raw_value;
}

async function updateCandidateStatuses(reconciliation, conflictFields) {
  for (const selection of Object.values(reconciliation.selected)) {
    if (!selection.candidate.id) continue;
    await updateCandidate(selection.candidate.id, {
      candidate_status: conflictFields.has(selection.candidate.field_name) ? "conflicted" : "selected",
      selected_reason: selection.reason,
      rejection_reason: null,
    });
  }
  for (const rejection of reconciliation.rejected) {
    if (!rejection.candidate.id) continue;
    await updateCandidate(rejection.candidate.id, {
      candidate_status: "rejected",
      rejection_reason: rejection.reason,
      selected_reason: null,
    });
  }
}

async function updateCandidate(id, patch) {
  const { error } = await supabase
    .from("shared_award_fact_candidates")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`Update fact candidate failed: ${error.message}`);
}

async function persistAudit(award, audit, publicPageSnapshot) {
  const reconciliationAuditSignature = crypto
    .createHash("sha256")
    .update(JSON.stringify(stableAuditSignatureValue({
      award_id: award.id,
      audit_status: audit.audit_status,
      severity: audit.severity,
      findings: audit.findings,
      suggested_fixes: audit.suggested_fixes,
      field_conflicts: audit.field_conflicts,
      source_rejections: audit.source_rejections,
      selected_fact_summary: audit.selected_fact_summary,
      public_page_snapshot: publicPageSnapshot,
    })))
    .digest("hex");
  const storedSnapshot = {
    ...(publicPageSnapshot && typeof publicPageSnapshot === "object" ? publicPageSnapshot : {}),
    reconciliation_audit_signature: reconciliationAuditSignature,
  };
  const row = {
    shared_award_id: award.id,
    audit_kind: "deterministic",
    audit_status: audit.audit_status,
    severity: audit.severity,
    findings: audit.findings,
    suggested_fixes: audit.suggested_fixes,
    field_conflicts: audit.field_conflicts,
    source_rejections: audit.source_rejections,
    selected_fact_summary: audit.selected_fact_summary,
    public_page_snapshot: storedSnapshot,
    model: "award-fact-reconciliation",
  };

  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const { data: existing, error: loadError } = await supabase
      .from("shared_award_page_audits")
      .select("id")
      .eq("shared_award_id", award.id)
      .eq("audit_kind", "deterministic")
      .contains("public_page_snapshot", { reconciliation_audit_signature: reconciliationAuditSignature })
      .limit(1);
    if (loadError) {
      lastError = loadError;
    } else if ((existing || []).length) {
      return;
    } else {
      const { error: insertError } = await supabase.from("shared_award_page_audits").insert(row);
      if (!insertError) return;
      lastError = insertError;
    }
    if (attempt < 4) await sleep(attempt * 1_500);
  }
  throw new Error(`Persist deterministic page audit failed: ${lastError?.message || "unknown Supabase error"}`);
}

async function publishAwardFacts(award, facts) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("shared_awards")
    .update({
      summary: buildAwardSummaryFromFacts(award, facts),
      public_facts: facts,
      public_facts_generated_at: now,
      public_facts_model: "award-fact-reconciliation",
      confidence: confidenceScore(facts.confidence),
      last_structure_scan_at: now,
      structure_scan_error: null,
      updated_at: now,
    })
    .eq("id", award.id);
  if (error) throw new Error(`Publish reconciled facts failed: ${error.message}`);
}

async function updateQueue(id, patch) {
  const { error } = await supabase
    .from("shared_award_reconciliation_queue")
    .update(patch)
    .eq("id", id);
  if (error) throw new Error(`Update reconciliation queue failed: ${error.message}`);
}

function confidenceScore(value) {
  if (value === "high") return 0.9;
  if (value === "medium") return 0.72;
  return 0.5;
}

function writeReport() {
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
    else {
      const next = values[index + 1];
      if (next && !next.startsWith("--")) {
        parsed[withoutPrefix] = next;
        index += 1;
      } else parsed[withoutPrefix] = "true";
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanNullable(value) {
  const text = String(value || "").trim();
  return text || null;
}

function isMissingTableError(error) {
  return /does not exist|schema cache|relation .* not found/i.test(error?.message || "");
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function errorMessage(error) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableAuditSignatureValue(value) {
  if (Array.isArray(value)) return value.map(stableAuditSignatureValue);
  if (!value || typeof value !== "object") return value;
  const volatileKeys = new Set([
    "captured_at",
    "checked_at",
    "created_at",
    "generated_at",
    "reconciliation_audit_signature",
    "updated_at",
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !volatileKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableAuditSignatureValue(nested)]),
  );
}

function printHelp() {
  console.log(`Reconcile impacted AwardPing public award pages.

Options:
  --limit=250
  --award-id=<uuid>
  --slug=<award-slug>
  --only-pending=true
  --only-failed=false
  --dry-run=true
  --apply=false
  --include-warnings=true
  --processing-timeout-minutes=45
  --json=false
`);
}
