#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  auditPublicAwardPage,
  buildAwardSummaryFromFacts,
  buildFactCandidatesFromSources,
  reconcileAwardFacts,
} from "./lib/award-fact-reconciliation.mjs";
import { isUsableAwardFactSource } from "./lib/source-quality.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const knownCanarySlugs = [
  "luce-acls-dissertation-fellowships-in-american-art",
  "afrl-summer-scholars-program",
];

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

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const slugFilter = listArg(args.slug);
const runAll = boolArg(args.all, false);
const runKnownCanaries = boolArg(args["known-canaries"], !runAll && !slugFilter.length);
const sampleSize = positiveInt(args["sample-size"], 25);
const apply = boolArg(args.apply, false);
const dryRun = boolArg(args["dry-run"], !apply);
const json = boolArg(args.json, false);
const failOnCritical = boolArg(args["fail-on-critical"], true);
const failOnPublicFactsUsingRejectedSource = boolArg(args["fail-on-public-facts-using-rejected-source"], true);

const startedAt = new Date().toISOString();
const runStamp = timestampForPath(startedAt);
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(reportDir, `public-page-audit-canaries-${runStamp}.json`);

const report = {
  started_at: startedAt,
  finished_at: null,
  status: "running",
  env_path: envPath,
  options: {
    slugs: slugFilter,
    all: runAll,
    known_canaries: runKnownCanaries,
    sample_size: sampleSize,
    apply,
    dry_run: dryRun,
    fail_on_critical: failOnCritical,
    fail_on_public_facts_using_rejected_source: failOnPublicFactsUsingRejectedSource,
  },
  checked: 0,
  passed: 0,
  warnings: 0,
  failed: 0,
  critical_failures: 0,
  public_facts_using_rejected_source: 0,
  applied: 0,
  canaries: [],
  errors: [],
};

try {
  mkdirSync(reportDir, { recursive: true });
  const awards = await loadAwards();
  for (const award of awards) {
    report.checked += 1;
    try {
      const sources = await loadSources(award.id);
      const usableSources = sources.filter(isUsableAwardFactSource);
      const candidates = buildFactCandidatesFromSources(award, usableSources);
      const reconciliation = reconcileAwardFacts(award, usableSources, candidates, {
        generatedAt: startedAt,
      });
      const audit = auditPublicAwardPage(award, reconciliation.selectedFacts, usableSources, { reconciliation });
      const diagnostics = diagnosePage({ award, reconciliation, audit });
      const rejectedSelected = selectedFactsUsingRejectedCandidates(reconciliation);
      if (rejectedSelected.length) report.public_facts_using_rejected_source += 1;

      if (audit.audit_status === "passed") report.passed += 1;
      else if (audit.audit_status === "warnings") report.warnings += 1;
      else report.failed += 1;
      if (audit.severity === "critical" || audit.should_block_publication) report.critical_failures += 1;

      const entry = {
        award_id: award.id,
        slug: award.slug,
        award_name: award.name,
        source_count: sources.length,
        usable_source_count: usableSources.length,
        candidate_count: candidates.length,
        selected_facts: reconciliation.selectedFacts,
        rejected_count: reconciliation.rejected.length,
        conflicts: reconciliation.conflicts,
        audit_status: audit.audit_status,
        severity: audit.severity,
        should_block_publication: audit.should_block_publication,
        findings: audit.findings,
        diagnostics,
        selected_rejected_candidate_ids: rejectedSelected,
      };
      report.canaries.push(entry);

      if (apply && !audit.should_block_publication) {
        await publishReconciledFacts(award, reconciliation, audit);
        report.applied += 1;
      }

      if (!json) {
        console.log(
          `CANARY ${audit.audit_status} severity=${audit.severity} rejected=${reconciliation.rejected.length} conflicts=${reconciliation.conflicts.length} ${award.slug || award.name}`,
        );
      }
    } catch (error) {
      report.failed += 1;
      const message = errorMessage(error);
      report.errors.push({ award_id: award.id, slug: award.slug, message });
      if (!json) console.log(`CANARY failed ${award.slug || award.name} | ${message}`);
    }
  }
  report.status = "succeeded";
} catch (error) {
  report.status = "failed";
  report.errors.push({ message: errorMessage(error) });
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(`CANARY_REPORT ${reportPath}`);
}

if (report.status === "succeeded") {
  if (failOnCritical && report.critical_failures > 0) process.exitCode = 1;
  if (failOnPublicFactsUsingRejectedSource && report.public_facts_using_rejected_source > 0) process.exitCode = 1;
}

async function loadAwards() {
  let query = supabase
    .from("shared_awards")
    .select("id,name,slug,official_homepage,summary,public_facts,confidence,status,last_structure_scan_at,created_at")
    .eq("status", "active")
    .order("created_at", { ascending: true });
  const slugs = slugFilter.length ? slugFilter : runKnownCanaries ? knownCanarySlugs : [];
  if (slugs.length) query = query.in("slug", slugs);
  if (!runAll && !slugs.length) query = query.limit(sampleSize);
  const { data, error } = await query;
  if (error) throw new Error(`Load awards failed: ${error.message}`);
  return runAll && sampleSize ? (data || []).slice(0, sampleSize) : data || [];
}

async function loadSources(awardId) {
  const { data, error } = await supabase
    .from("shared_award_sources")
    .select("id,shared_award_id,url,title,display_title,page_description,page_metadata,page_metadata_generated_at,page_metadata_model,page_type,source,reason,submitted_by_user_id,admin_review_status,confidence")
    .eq("shared_award_id", awardId)
    .eq("admin_review_status", "open")
    .order("page_metadata_generated_at", { ascending: false });
  if (error) throw new Error(`Load sources failed: ${error.message}`);
  return data || [];
}

async function publishReconciledFacts(award, reconciliation, audit) {
  const now = new Date().toISOString();
  const summary = buildAwardSummaryFromFacts(award, reconciliation.selectedFacts);
  const { error: auditError } = await supabase.from("shared_award_page_audits").insert({
    shared_award_id: award.id,
    audit_kind: "regression",
    audit_status: audit.audit_status,
    severity: audit.severity,
    findings: audit.findings,
    suggested_fixes: audit.suggested_fixes,
    field_conflicts: audit.field_conflicts,
    source_rejections: audit.source_rejections,
    selected_fact_summary: audit.selected_fact_summary,
    public_page_snapshot: {
      summary,
      public_facts: reconciliation.selectedFacts,
      generated_by: "evaluate-public-page-audit-canaries",
    },
    model: "award-fact-reconciliation",
  });
  if (auditError) throw new Error(`Insert audit failed: ${auditError.message}`);

  const { error } = await supabase
    .from("shared_awards")
    .update({
      summary,
      public_facts: reconciliation.selectedFacts,
      public_facts_generated_at: now,
      public_facts_model: "award-fact-reconciliation",
      confidence: confidenceScore(reconciliation.selectedFacts.confidence),
      last_structure_scan_at: now,
      structure_scan_error: null,
      updated_at: now,
    })
    .eq("id", award.id);
  if (error) throw new Error(`Publish reconciled facts failed: ${error.message}`);
}

function diagnosePage({ reconciliation, audit }) {
  const selected = reconciliation.selectedFacts;
  return {
    sibling_source_contamination_detected: reconciliation.rejected.some((item) => item.reason === "sibling_program_identity_mismatch") || audit.findings.some((item) => /sibling/i.test(item.code)),
    unsupported_description: audit.findings.some((item) => item.field_name === "overview"),
    deadline_conflict: reconciliation.conflicts.some((item) => item.field_name === "deadline"),
    invented_future_deadline: Boolean(selected.deadline && selected.cycle_status === "upcoming" && !selectionHasEvidence(reconciliation.selected.deadline)),
    stale_cycle_shown_as_upcoming: selected.cycle_status === "upcoming" && deadlineIsPast(selected.deadline),
    public_fact_selected_from_rejected_source: selectedFactsUsingRejectedCandidates(reconciliation).length > 0,
    missing_amount_despite_official_evidence: audit.findings.some((item) => item.code === "missing_amount_with_official_evidence"),
    vague_or_conflicting_application_materials: reconciliation.conflicts.some((item) => item.field_name === "application_materials") || (selected.application_materials || []).some((item) => /^supporting documents?$/i.test(item)),
    generic_listing_source_used_for_specific_facts: Object.values(reconciliation.selected).some((selection) => /\b(search|listing|directory|database)\b/i.test(`${selection.source?.url || ""} ${selection.source?.title || ""}`)),
  };
}

function selectedFactsUsingRejectedCandidates(reconciliation) {
  const rejectedIds = new Set(reconciliation.rejected.map((item) => item.candidate.id).filter(Boolean));
  return Object.values(reconciliation.selected)
    .map((item) => item.candidate.id)
    .filter((id) => id && rejectedIds.has(id));
}

function selectionHasEvidence(selection) {
  if (!selection) return false;
  return Boolean(cleanString(selection.candidate.evidence_quote) || cleanString(selection.source?.page_metadata?.baseline_facts?.evidence_quotes?.[0]));
}

function deadlineIsPast(value) {
  const date = Date.parse(String(value || ""));
  return Number.isFinite(date) && date < Date.now();
}

function confidenceScore(value) {
  const clean = String(value || "").toLowerCase();
  if (clean === "high") return 90;
  if (clean === "medium") return 70;
  if (clean === "low") return 45;
  return 60;
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    parsed[key] = rest.length ? rest.join("=") : "true";
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

function listArg(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|y)$/i.test(String(value));
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanString(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function errorMessage(error) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}

function printHelp() {
  console.log(`Evaluate public page audit canaries with generic reconciliation logic.

Examples:
  node scripts/evaluate-public-page-audit-canaries.mjs --known-canaries=true --dry-run=true
  node scripts/evaluate-public-page-audit-canaries.mjs --slug=luce-acls-dissertation-fellowships-in-american-art --json=true

Options:
  --slug=a,b
  --all=true
  --known-canaries=true
  --sample-size=25
  --dry-run=true
  --apply=false
  --json=false
  --fail-on-critical=true
  --fail-on-public-facts-using-rejected-source=true
`);
}
