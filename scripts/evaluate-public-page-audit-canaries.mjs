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
import { requireRegressionEvaluation } from "./lib/regression-audit-observation.mjs";
import {
  closeSupabaseServiceTransport,
  createSupabaseServiceClient,
} from "./supabase-service-client.mjs";

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
if (apply && dryRun) {
  console.error("--apply=true cannot be combined with --dry-run=true.");
  process.exit(2);
}
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
  audit_rows_persisted: 0,
  audit_rows_deduplicated: 0,
  blocked_audits_recorded: 0,
  audit_results_superseded_by_newer_evaluation: 0,
  regression_state_updates: 0,
  operational_failures_recorded: 0,
  operational_failure_recording_errors: 0,
  applied: 0,
  canaries: [],
  errors: [],
};

try {
  mkdirSync(reportDir, { recursive: true });
  const awards = await loadAwards();
  for (const award of awards) {
    report.checked += 1;
    let outcomeCounted = false;
    let attemptStage = "evaluation";
    try {
      const evaluation = requireRegressionEvaluation(award);
      const sources = evaluation.sources;
      const usableSources = sources.filter(isUsableAwardFactSource);
      const candidates = buildFactCandidatesFromSources(award, usableSources);
      const reconciliation = reconcileAwardFacts(award, usableSources, candidates, {
        generatedAt: evaluation.selectedAt,
      });
      const audit = auditPublicAwardPage(award, reconciliation.selectedFacts, usableSources, { reconciliation });
      const diagnostics = diagnosePage({ award, reconciliation, audit });
      const rejectedSelected = selectedFactsUsingRejectedCandidates(reconciliation);
      if (rejectedSelected.length) report.public_facts_using_rejected_source += 1;

      if (audit.audit_status === "passed") report.passed += 1;
      else if (audit.audit_status === "warnings") report.warnings += 1;
      else report.failed += 1;
      outcomeCounted = true;
      if (audit.severity === "critical" || audit.should_block_publication) report.critical_failures += 1;

      const entry = {
        award_id: award.id,
        slug: award.slug,
        award_name: award.name,
        evaluation_revision: evaluation.revision,
        evaluation_selected_at: evaluation.selectedAt,
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

      if (apply) {
        attemptStage = "persistence";
        const persistence = await persistAuditResult(award, reconciliation, audit);
        if (persistence.inserted) report.audit_rows_persisted += 1;
        else report.audit_rows_deduplicated += 1;
        report.regression_state_updates += 1;
        if (audit.should_block_publication) report.blocked_audits_recorded += 1;
        if (persistence.latest_state_advanced === false) {
          report.audit_results_superseded_by_newer_evaluation += 1;
        }
        entry.persistence = {
          audit_id: persistence.audit_id,
          inserted: persistence.inserted,
          latest_state_advanced: persistence.latest_state_advanced !== false,
          evaluation_accepted_at: persistence.evaluation_accepted_at || null,
        };
      }

      if (!json) {
        console.log(
          `CANARY ${audit.audit_status} severity=${audit.severity} rejected=${reconciliation.rejected.length} conflicts=${reconciliation.conflicts.length} ${award.slug || award.name}`,
        );
      }
    } catch (error) {
      if (!outcomeCounted) report.failed += 1;
      const message = errorMessage(error);
      let failureState = null;
      let failureStateError = null;
      if (apply) {
        try {
          failureState = await persistOperationalFailure(
            award.id,
            `regression_audit_${attemptStage}_failed:${message}`,
          );
          report.operational_failures_recorded += 1;
        } catch (stateError) {
          failureStateError = errorMessage(stateError);
          report.operational_failure_recording_errors += 1;
        }
      }
      report.errors.push({
        award_id: award.id,
        slug: award.slug,
        stage: attemptStage,
        message,
        failure_state: failureState,
        failure_state_error: failureStateError,
      });
      if (!json) console.log(`CANARY failed ${award.slug || award.name} | ${message}`);
    }
  }
  if (!report.errors.length) report.status = "succeeded";
  else if (
    apply
    && report.operational_failures_recorded === report.errors.length
    && report.operational_failure_recording_errors === 0
  ) report.status = "succeeded_with_deferred_failures";
  else {
    report.status = "failed";
    process.exitCode = 1;
  }
} catch (error) {
  report.status = "failed";
  report.errors.push({ message: errorMessage(error) });
  process.exitCode = 1;
} finally {
  try {
    report.finished_at = new Date().toISOString();
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(`CANARY_REPORT ${reportPath}`);
  } finally {
    await closeSupabaseServiceTransport();
  }
}

if (report.status !== "failed") {
  if (failOnCritical && report.critical_failures > 0) process.exitCode = 1;
  if (failOnPublicFactsUsingRejectedSource && report.public_facts_using_rejected_source > 0) process.exitCode = 1;
}

async function loadAwards() {
  const slugs = slugFilter.length ? slugFilter : runKnownCanaries ? knownCanarySlugs : [];
  const { data, error } = await supabase.rpc("list_shared_awards_for_regression_audit", {
    p_limit: slugs.length || sampleSize,
    p_slugs: slugs.length ? slugs : null,
    p_include_deferred: dryRun || slugs.length > 0,
  });
  if (error) throw new Error(`Load awards failed: ${error.message}`);
  // `--all=true` selects from the whole active catalog, but each leased run is
  // intentionally bounded. The service-only selector keeps its cursor and
  // retry/backoff state outside shared_awards so operational scans cannot
  // perturb public facts, structure freshness, or Stage 1 review hashes.
  if (!Array.isArray(data)) throw new Error("Load awards failed: selector returned no award array.");
  return data;
}

async function persistAuditResult(award, reconciliation, audit) {
  const evaluation = requireRegressionEvaluation(award);
  const auditRow = {
    audit_kind: "regression",
    audit_status: audit.audit_status,
    severity: audit.severity,
    findings: audit.findings,
    suggested_fixes: audit.suggested_fixes,
    field_conflicts: audit.field_conflicts,
    source_rejections: audit.source_rejections,
    selected_fact_summary: audit.selected_fact_summary,
    public_page_snapshot: {
      observed_summary: award.summary || null,
      observed_public_facts: award.public_facts || {},
      proposed_reconciled_summary: buildAwardSummaryFromFacts(award, reconciliation.selectedFacts),
      proposed_reconciled_facts: reconciliation.selectedFacts,
      selected_evidence_bindings: buildSelectedEvidenceBindings(reconciliation),
      generated_by: "evaluate-public-page-audit-canaries",
      evaluation_contract_version: evaluation.contractVersion,
      evaluation_revision: evaluation.revision,
      evaluation_source_count: evaluation.sourceCount,
      evaluated_at: evaluation.selectedAt,
      applied_to_public: false,
      observation_only: true,
    },
    model: "award-fact-reconciliation",
  };
  const { data, error } = await supabase.rpc("record_shared_award_regression_audit", {
    p_shared_award_id: award.id,
    p_audit_row: auditRow,
    p_audit_outcome_error: regressionAuditErrorFor(audit),
  });
  if (error) throw new Error(`Persist regression page audit failed: ${error.message}`);
  if (!data?.audit_id || typeof data?.inserted !== "boolean") {
    throw new Error("Persist regression page audit failed: RPC returned no durable audit identity.");
  }
  return data;
}

function buildSelectedEvidenceBindings(reconciliation) {
  return Object.entries(reconciliation.selected || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fieldName, selection]) => {
      const candidate = selection?.candidate || {};
      const source = selection?.source || {};
      const baselineFacts = source?.page_metadata?.baseline_facts || {};
      return {
        field_name: fieldName,
        candidate_id: candidate.id || null,
        source_id: source.id || candidate.shared_award_source_id || null,
        source_url: source.url || candidate.source_url || null,
        source_role: candidate.source_role || null,
        normalized_value: candidate.normalized_value ?? selection?.value ?? null,
        evidence_quote: candidate.evidence_quote || null,
        evidence_location: candidate.evidence_location || null,
        extracted_at: candidate.extracted_at || null,
        source_captured_at: source.page_metadata_generated_at || null,
        reconciliation_audit_signature:
          source?.page_metadata?.reconciliation_audit_signature
          || baselineFacts.reconciliation_audit_signature
          || null,
        source_evidence_hashes: {
          capture_file_hash: baselineFacts.capture_file_hash || source?.page_metadata?.capture_file_hash || null,
          file_hash: baselineFacts.file_hash || source?.page_metadata?.file_hash || null,
          main_content_hash: baselineFacts.main_content_hash || source?.page_metadata?.main_content_hash || null,
          text_hash: baselineFacts.text_hash || source?.page_metadata?.text_hash || null,
        },
      };
    });
}

async function persistOperationalFailure(awardId, message) {
  const operationalError = cleanString(message).slice(0, 1000) || "regression_audit_attempt_failed";
  const { data, error } = await supabase.rpc(
    "record_shared_award_regression_audit_attempt_failure",
    {
      p_shared_award_id: awardId,
      p_operational_error: operationalError,
    },
  );
  if (error) throw new Error(`Persist regression audit failure state failed: ${error.message}`);
  if (!data?.attempt_recorded_at || !Number.isInteger(data?.consecutive_failures)) {
    throw new Error("Persist regression audit failure state failed: RPC returned no durable retry state.");
  }
  return data;
}

function regressionAuditErrorFor(audit) {
  if (!audit.should_block_publication) return null;
  const findingCodes = (audit.findings || [])
    .map((finding) => cleanString(finding?.code || finding?.field_name || "finding"))
    .filter(Boolean)
    .slice(0, 8);
  return [
    "regression_page_audit_blocked",
    cleanString(audit.audit_status) || "failed",
    cleanString(audit.severity) || "error",
    ...findingCodes,
  ].join(":").slice(0, 1000);
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
  --all=true                Select a fair oldest-first batch from all active awards
  --known-canaries=true
  --sample-size=25          Maximum awards per catalog batch; explicit slugs are capped at 250
  --dry-run=true
  --apply=false
  --json=false
  --fail-on-critical=true
  --fail-on-public-facts-using-rejected-source=true
`);
}
