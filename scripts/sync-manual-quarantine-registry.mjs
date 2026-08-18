#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  historicalLocalizationInventoryDigest,
  validateHistoricalLocalizationInventory,
} from "./lib/manual-quarantine.mjs";
import { formatLaneFailureReceipt } from "./lib/lane-failure-receipt.mjs";
import {
  closeSupabaseServiceTransport,
  createSupabaseServiceClient,
} from "./supabase-service-client.mjs";

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const args = parseArgs(process.argv.slice(2));
  if (boolArg(args.help, false, "--help")) {
    printHelp();
    return 0;
  }

  let apply;
  let dryRun;
  try {
    apply = boolArg(args.apply, false, "--apply");
    dryRun = boolArg(args["dry-run"], !apply, "--dry-run");
  } catch (error) {
    console.error(`MANUAL_QUARANTINE_SYNC_ARGUMENT_ERROR ${error.message}`);
    return 1;
  }
  if (apply && dryRun) {
    console.error(
      "MANUAL_QUARANTINE_SYNC_ARGUMENT_ERROR --apply=true and --dry-run=true cannot be used together.",
    );
    return 1;
  }
  if (!apply && !dryRun) {
    console.error(
      "MANUAL_QUARANTINE_SYNC_ARGUMENT_ERROR Remote mutation requires explicit --apply=true.",
    );
    return 1;
  }

  let historicalImport;
  try {
    historicalImport = prepareHistoricalImport({ args, root });
  } catch (error) {
    console.error(`MANUAL_QUARANTINE_HISTORY_FAILED ${error.message}`);
    return 1;
  }

  if (!apply) {
    console.log("MANUAL_QUARANTINE_SYNC_DRY_RUN");
    console.log(JSON.stringify({
      mode: "dry_run",
      remote_mutations: 0,
      paid_api_calls: 0,
      planned_rpc_calls: [
        "sync_manual_quarantine_registry",
        ...(historicalImport
          ? ["replace_manual_quarantine_historical_limitations"]
          : []),
      ],
      historical_import: publicHistoricalImport(historicalImport),
      apply_command: "Repeat with --apply=true after reviewing this plan.",
    }, null, 2));
    return 0;
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
    return 1;
  }

  const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
  const { data: synced, error: syncError } = await supabase.rpc(
    "sync_manual_quarantine_registry",
  );
  if (syncError) {
    console.error(`MANUAL_QUARANTINE_SYNC_FAILED ${syncError.message}`);
    console.error(formatLaneFailureReceipt(manualQuarantineFailureReceipt(syncError)));
    return 1;
  }

  let state = synced;
  if (historicalImport) {
    const { data, error } = await supabase.rpc(
      "replace_manual_quarantine_historical_limitations",
      {
        p_source_ids: historicalImport.source_ids,
        p_reported_at: historicalImport.reported_at,
        p_report_digest: historicalImport.report_digest,
      },
    );
    if (error) {
      console.error(`MANUAL_QUARANTINE_HISTORY_FAILED ${error.message}`);
      return 1;
    }
    state = data;
  }

  console.log("MANUAL_QUARANTINE_REGISTRY_SYNCED");
  console.log(JSON.stringify({
    mode: "apply",
    state,
    historical_import: publicHistoricalImport(historicalImport),
  }, null, 2));
  return 0;
}

export function manualQuarantineFailureReceipt(error) {
  const message = String(error?.message || error || "");
  if (/statement timeout|canceling statement due to statement timeout/i.test(message)) {
    return {
      lane_key: "manual_quarantine",
      failure_code: "database_statement_timeout",
      retry_automatic: true,
      creates_api_charge: false,
    };
  }
  return {
    lane_key: "manual_quarantine",
    failure_code: "registry_sync_failed",
    retry_automatic: true,
    creates_api_charge: false,
  };
}

function prepareHistoricalImport({ args, root }) {
  if (!args["historical-report"]) return null;

  const reportPath = resolve(root, String(args["historical-report"]));
  if (!existsSync(reportPath)) {
    throw new Error(`missing_report=${reportPath}`);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`invalid_report_json=${error.message}`);
  }
  const inventory = validateHistoricalLocalizationInventory(report);
  if (!inventory.complete) {
    throw new Error(`reason=${inventory.reason}`);
  }
  const reportedAt = String(report.finished_at || report.started_at || "").trim();
  if (!reportedAt || !Number.isFinite(Date.parse(reportedAt))) {
    throw new Error("report_timestamp_missing_or_invalid");
  }
  return {
    source_ids: inventory.sourceIds,
    source_count: inventory.sourceIds.length,
    report_path: reportPath,
    report_digest: historicalLocalizationInventoryDigest(report),
    reported_at: new Date(reportedAt).toISOString(),
  };
}

function publicHistoricalImport(value) {
  if (!value) return null;
  return {
    source_count: value.source_count,
    report_path: value.report_path,
    report_digest: value.report_digest,
    reported_at: value.reported_at,
  };
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
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
  if (!existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function boolArg(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (/^(1|true|yes|y|on)$/i.test(String(value).trim())) return true;
  if (/^(0|false|no|n|off)$/i.test(String(value).trim())) return false;
  throw new Error(`${label} must be true or false.`);
}

function printHelp() {
  console.log(`Synchronize AwardPing's durable manual quarantine registry.

This command is read-only by default. A dry run performs no environment load,
network request, database mutation, capture, or paid API call.

Usage:
  node scripts/sync-manual-quarantine-registry.mjs [--dry-run=true]
  node scripts/sync-manual-quarantine-registry.mjs --apply=true [options]

Options:
  --apply=true                 Explicitly permit the database RPC mutations
  --dry-run=true               Print the local mutation plan (default)
  --historical-report=<path>   Validate and plan/import a complete history report
  --env=<path>                 Environment file used only with --apply=true
  --help                       Show this help without environment or network access
`);
}

if (Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let exitCode = 1;
  try {
    exitCode = await main();
  } finally {
    await closeSupabaseServiceTransport();
  }
  process.exitCode = exitCode;
}
