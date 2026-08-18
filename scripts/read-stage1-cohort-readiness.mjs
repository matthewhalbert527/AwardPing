#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allStage1SearchKeys,
  buildStage1ReadinessReport,
} from "./lib/stage1-cohort-readiness.mjs";
import {
  fetchExactRows,
  fetchExactStableChunkedRows,
  fetchExactStableRows,
} from "./lib/stage1-readiness-query.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
const envChoice = String(args.env || defaultEnvFile());
const envPath = resolve(root, envChoice);
const env = {
  ...(existsSync(envPath) ? loadEnvFile(envPath) : {}),
  ...process.env,
};
const generatedAt = new Date().toISOString();
const archiveRoot = resolve(String(
  args["archive-dir"]
  || env.AWARDPING_VISUAL_SNAPSHOT_DIR
  || "D:\\AwardPingVisualSnapshots",
));
const outputPath = resolve(
  root,
  String(args.output || join("reports", `stage1-cohort-readiness-${fileTimestamp(generatedAt)}.json`)),
);
const failOnBlockers = booleanArg(args["fail-on-blockers"], false);
const queryInventory = {
  env_file: existsSync(envPath) ? relativeToRoot(envPath) : null,
  credentials_loaded_without_printing_values: false,
  archive_root_exists: existsSync(archiveRoot),
  queries: {},
  errors: [],
};

let publicationSnapshot = null;
let publicationSnapshotError = null;
let registryMode = "fallback_exact_definition";
let awards = [];
let sources = [];
let visualSnapshots = [];
let factCandidates = [];
let reconciliations = [];
let pageAudits = [];
let quarantines = [];
let manifests = [];
let factLedger = [];

const supabaseUrl = cleanText(env.NEXT_PUBLIC_SUPABASE_URL);
const serviceRoleKey = cleanText(env.SUPABASE_SERVICE_ROLE_KEY);
if (!supabaseUrl || !serviceRoleKey) {
  publicationSnapshotError = "missing_server_supabase_credentials";
  queryInventory.errors.push({
    query: "configuration",
    code: "missing_server_supabase_credentials",
    message: "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
  });
} else {
  queryInventory.credentials_loaded_without_printing_values = true;
  const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
  const snapshotResult = await supabase.rpc("get_stage1_publication_snapshot");
  if (snapshotResult.error) {
    publicationSnapshotError = safeError(snapshotResult.error);
    queryInventory.errors.push({
      query: "get_stage1_publication_snapshot",
      code: snapshotResult.error.code || "rpc_unavailable",
      message: publicationSnapshotError,
    });
  } else if (snapshotResult.data && typeof snapshotResult.data === "object") {
    publicationSnapshot = snapshotResult.data;
    registryMode = "remote_service_snapshot";
    queryInventory.queries.get_stage1_publication_snapshot = {
      rows: Array.isArray(snapshotResult.data.cohorts) ? snapshotResult.data.cohorts.length : 0,
      access: "service_only_rpc",
    };
  } else {
    publicationSnapshotError = "stage1_publication_snapshot_returned_no_object";
    queryInventory.errors.push({
      query: "get_stage1_publication_snapshot",
      code: "invalid_rpc_payload",
      message: publicationSnapshotError,
    });
  }

  awards = await readOrEmpty("shared_awards_by_exact_search_key", async () => {
    const rows = await fetchChunked({
      values: allStage1SearchKeys(),
      chunkSize: 15,
      run: (chunk) => fetchPagedChunk(
        () => supabase
          .from("shared_awards")
          .select("id,search_key,name,slug,official_homepage,public_facts,public_facts_generated_at,public_facts_model,status,confidence,last_structure_scan_at,structure_scan_error,updated_at", { count: "exact" })
          .in("search_key", chunk)
          .order("search_key", { ascending: true })
          .order("id", { ascending: true }),
        "shared_awards_by_exact_search_key",
      ),
    });
    const remoteMemberIds = (publicationSnapshot?.cohorts || [])
      .flatMap((row) => row.members || [])
      .map((member) => member.shared_award_id);
    const knownIds = new Set(rows.map((row) => row.id));
    const missingRemoteIds = [...new Set(remoteMemberIds)].filter((id) => !knownIds.has(id));
    if (missingRemoteIds.length) {
      const extras = await fetchChunked({
        values: missingRemoteIds,
        chunkSize: 40,
        run: (chunk) => fetchPagedChunk(
          () => supabase
            .from("shared_awards")
            .select("id,search_key,name,slug,official_homepage,public_facts,public_facts_generated_at,public_facts_model,status,confidence,last_structure_scan_at,structure_scan_error,updated_at", { count: "exact" })
            .in("id", chunk)
            .order("id", { ascending: true }),
          "shared_awards_by_remote_member_id",
        ),
      });
      rows.push(...extras);
    }
    return dedupeRows(rows);
  });

  const awardIds = awards.map((award) => award.id);
  if (awardIds.length) {
    sources = await readOrEmpty("shared_award_sources", () => fetchChunked({
      values: awardIds,
      chunkSize: 40,
      run: (chunk) => fetchPagedChunk(
        () => supabase
          .from("shared_award_sources")
          .select("id,shared_award_id,url,title,display_title,page_description,page_type,confidence,reason,source,admin_review_status,admin_review_note,admin_reviewed_at,admin_reviewed_by,last_hash,last_checked_at,next_check_at,consecutive_failures,last_error,created_at,updated_at", { count: "exact" })
          .in("shared_award_id", chunk)
          .order("id", { ascending: true }),
        "shared_award_sources",
      ),
    }));

    [visualSnapshots, factCandidates, reconciliations, pageAudits, quarantines] = await Promise.all([
      readOrEmpty("shared_award_source_visual_snapshots", () => fetchChunked({
        values: awardIds,
        chunkSize: 40,
        run: (chunk) => fetchPagedChunk(
          () => supabase
            .from("shared_award_source_visual_snapshots")
            .select("shared_award_source_id,shared_award_id,source_url,source_title,source_page_type,kind,bucket,latest_captured_at,latest_object_keys,latest_hashes,latest_metadata,previous_captured_at,previous_object_keys,previous_hashes,previous_metadata,created_at,updated_at", { count: "exact" })
            .in("shared_award_id", chunk)
            .order("shared_award_source_id", { ascending: true }),
          "shared_award_source_visual_snapshots",
        ),
      })),
      readOrEmpty("shared_award_fact_candidates", () => fetchChunked({
        values: awardIds,
        chunkSize: 40,
        run: (chunk) => fetchPagedChunk(
          () => supabase
            .from("shared_award_fact_candidates")
            .select("id,shared_award_id,shared_award_source_id,source_url,source_title,source_role,source_quality_decision,field_name,raw_value,normalized_value,evidence_quote,evidence_location,extracted_at,model,confidence,candidate_status,rejection_reason,selected_reason,metadata,created_at,updated_at", { count: "exact" })
            .in("shared_award_id", chunk)
            .order("id", { ascending: true }),
          "shared_award_fact_candidates",
        ),
      })),
      readOrEmpty("shared_award_reconciliation_queue", () => fetchChunked({
        values: awardIds,
        chunkSize: 40,
        run: (chunk) => fetchPagedChunk(
          () => supabase
            .from("shared_award_reconciliation_queue")
            .select("id,shared_award_id,reason,source_ids,candidate_ids,status,priority,created_at,started_at,completed_at,error,metadata", { count: "exact" })
            .in("shared_award_id", chunk)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false }),
          "shared_award_reconciliation_queue",
        ),
      })),
      readOrEmpty("shared_award_page_audits", async () => {
        const deterministicRows = await fetchChunked({
          values: awardIds,
          chunkSize: 15,
          run: (chunk) => fetchPagedChunk(
            () => supabase
              .from("shared_award_page_audits")
              .select("id,shared_award_id,audit_kind,audit_status,severity,findings,suggested_fixes,field_conflicts,source_rejections,selected_fact_summary,public_page_snapshot,model,gemini_batch_name,gemini_batch_request_key,created_at,resolved_at,resolved_by,resolution_note", { count: "exact" })
              .in("shared_award_id", chunk)
              .eq("audit_kind", "deterministic")
              .order("shared_award_id", { ascending: true })
              .order("created_at", { ascending: false })
              .order("id", { ascending: false }),
            "deterministic shared_award_page_audits",
          ),
        });
        const unresolvedRows = await fetchChunked({
          values: awardIds,
          chunkSize: 15,
          run: (chunk) => fetchPagedChunk(
            () => supabase
              .from("shared_award_page_audits")
              .select("id,shared_award_id,audit_kind,audit_status,severity,findings,suggested_fixes,field_conflicts,source_rejections,selected_fact_summary,public_page_snapshot,model,gemini_batch_name,gemini_batch_request_key,created_at,resolved_at,resolved_by,resolution_note", { count: "exact" })
              .in("shared_award_id", chunk)
              .is("resolved_at", null)
              .or("audit_status.in.(failed,needs_review),severity.eq.critical")
              .order("shared_award_id", { ascending: true })
              .order("created_at", { ascending: false })
              .order("id", { ascending: false }),
            "unresolved shared_award_page_audits",
          ),
        });
        return dedupeRows([...deterministicRows, ...unresolvedRows]);
      }),
      readOrEmpty("manual_quarantine_registry_by_award", () => fetchChunked({
        values: awardIds,
        chunkSize: 40,
        run: (chunk) => fetchPagedChunk(
          () => supabase
            .from("manual_quarantine_registry")
            .select("id,quarantine_key,case_key,classification,category,status,requires_action,terminal,terminal_failure_count,severity,public_impact,owner,retry_mode,retry_charge,title,reason_code,reason,recommended_action,shared_award_id,shared_award_source_id,visual_review_candidate_id,primary_source_table,primary_source_record_id,evidence_record_count,evidence_hash,policy_id,policy_version,policy_hash,first_observed_at,last_observed_at,quarantined_at,resolved_at,resolved_by,resolution_note,created_at,updated_at", { count: "exact" })
            .in("shared_award_id", chunk)
            .order("id", { ascending: true }),
          "manual_quarantine_registry_by_award",
        ),
      })),
    ]);

    const sourceOnlyQuarantines = await readOrEmpty("manual_quarantine_registry_by_source", () => fetchChunked({
      values: sources.map((source) => source.id),
      chunkSize: 100,
      run: (chunk) => fetchPagedChunk(
        () => supabase
          .from("manual_quarantine_registry")
          .select("id,quarantine_key,case_key,classification,category,status,requires_action,terminal,terminal_failure_count,severity,public_impact,owner,retry_mode,retry_charge,title,reason_code,reason,recommended_action,shared_award_id,shared_award_source_id,visual_review_candidate_id,primary_source_table,primary_source_record_id,evidence_record_count,evidence_hash,policy_id,policy_version,policy_hash,first_observed_at,last_observed_at,quarantined_at,resolved_at,resolved_by,resolution_note,created_at,updated_at", { count: "exact" })
          .in("shared_award_source_id", chunk)
          .order("id", { ascending: true }),
        "manual_quarantine_registry_by_source",
      ),
    }));
    quarantines = dedupeRows([...quarantines, ...sourceOnlyQuarantines]);
  }

  if (registryMode === "remote_service_snapshot") {
    [manifests, factLedger] = await Promise.all([
      readOrEmpty("stage1_award_source_manifest", () => fetchPaged(
        () => supabase
          .from("stage1_award_source_manifest")
          .select("cohort_key,source_role,manifest_status,source_ids,evidence,checked_at,policy_version,created_at,updated_at", { count: "exact" })
          .order("cohort_key", { ascending: true })
          .order("source_role", { ascending: true }),
        "stage1_award_source_manifest",
      )),
      readOrEmpty("stage1_award_fact_publication_ledger", () => fetchPaged(
        () => supabase
          .from("stage1_award_fact_publication_ledger")
          .select("id,verification_batch_id,cohort_key,field_name,candidate_id,source_id,source_url,source_role,supporting_text,source_snapshot_hashes,source_captured_at,reconciliation_id,page_audit_id,normalized_value,public_value,cycle,policy_version,evidence_hash,verified_at", { count: "exact" })
          .order("cohort_key", { ascending: true })
          .order("id", { ascending: true }),
        "stage1_award_fact_publication_ledger",
      )),
    ]);
  }
}

const report = buildStage1ReadinessReport({
  generatedAt,
  registryMode,
  publicationSnapshot,
  publicationSnapshotError,
  awards,
  sources,
  visualSnapshots,
  factCandidates,
  reconciliations,
  pageAudits,
  quarantines,
  manifests,
  factLedger,
  archiveRoot,
  queryInventory,
});

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`Stage 1 readiness report: ${outputPath}`);
console.log(`Registry source: ${report.registry.mode}`);
console.log(`Exact cohort: ${report.summary.exact_cohort_count}/25`);
console.log("Verification policy: immutable evidence stays valid while exact identities match; live sources and the signed R2 public gate must stay current.");
console.log(`Reviewed-promotion ready: ${report.summary.ready_for_reviewed_promotion_count}/25`);
console.log(`Verified-beta ready: ${report.summary.ready_for_verified_beta_count}/25`);
console.log(`Blocked: ${report.summary.blocked_count}/25`);
console.log(`Open actionable quarantine: ${report.summary.actionable_quarantine_open}`);
console.log(`Safe next actions: ${report.safe_next_action_plan.action_count}`);
console.log(`Read-only: remote_mutations=0 paid_api_calls=0 captures=0 r2_object_requests=0`);

if (failOnBlockers && (report.summary.blocked_count > 0 || report.global_blockers.length > 0)) {
  process.exitCode = 2;
}

async function readOrEmpty(label, operation) {
  try {
    const rows = await operation();
    queryInventory.queries[label] = {
      rows: rows.length,
      exact_uncapped: true,
      stable_revision_verified: true,
    };
    return rows;
  } catch (error) {
    queryInventory.errors.push({ query: label, code: error?.code || "query_failed", message: safeError(error) });
    return [];
  }
}

async function fetchChunked({ values, chunkSize, run }) {
  return fetchExactStableChunkedRows({ values, chunkSize, run });
}

async function fetchPaged(buildQuery, label) {
  return fetchExactStableRows(buildQuery, label);
}

async function fetchPagedChunk(buildQuery, label) {
  return fetchExactRows(buildQuery, label);
}

function dedupeRows(rows) {
  return [...new Map(rows.map((row) => [row.id || row.shared_award_source_id || `${row.cohort_key}:${row.source_role}`, row])).values()];
}

function defaultEnvFile() {
  if (existsSync(resolve(root, ".env.worker.local"))) return ".env.worker.local";
  return ".env.local";
}

function parseArgs(values) {
  const parsed = {};
  const allowed = new Set([
    "archive-dir",
    "env",
    "fail-on-blockers",
    "help",
    "output",
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${value}`);
    }
    const raw = value.slice(2);
    if (raw.includes("=")) {
      const [key, ...rest] = raw.split("=");
      if (!allowed.has(key)) throw new Error(`Unknown option --${key}.`);
      if (key === "help") throw new Error("--help does not accept a value.");
      parsed[key] = rest.join("=");
      continue;
    }
    if (!allowed.has(raw)) throw new Error(`Unknown option --${raw}.`);
    if (raw === "help") {
      parsed.help = true;
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[raw] = next;
      index += 1;
    } else if (raw === "fail-on-blockers") {
      parsed[raw] = true;
    } else {
      throw new Error(`--${raw} requires a value.`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  npm run stage1:readiness -- [options]

Options:
  --env=<path>                Environment file (default: .env.worker.local, then .env.local)
  --archive-dir=<path>        Local visual-evidence archive root
  --output=<path>             Local JSON report path
  --fail-on-blockers=<bool>   Exit nonzero when the report has release blockers
  --help                      Show this message without loading credentials or remote data

Safety:
  This command performs read-only evidence queries and writes one local report.
  It never mutates the database, captures pages, reads R2 objects, or calls paid providers.`);
}

function loadEnvFile(path) {
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

function booleanArg(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (/^(1|true|yes|y)$/i.test(String(value))) return true;
  if (/^(0|false|no|n)$/i.test(String(value))) return false;
  return fallback;
}

function fileTimestamp(value) {
  return value.replace(/[:.]/g, "-");
}

function cleanText(value) {
  return String(value || "").trim();
}

function safeError(error) {
  return String(error?.message || error || "unknown_error")
    .replace(/(eyJ[a-zA-Z0-9._-]+)/g, "[redacted-token]")
    .replace(/(sb_(?:secret|publishable)_[a-zA-Z0-9_-]+)/g, "[redacted-key]")
    .slice(0, 1_000);
}

function relativeToRoot(path) {
  const absolute = resolve(path);
  return absolute.startsWith(root) ? absolute.slice(root.length + 1) : absolute;
}
