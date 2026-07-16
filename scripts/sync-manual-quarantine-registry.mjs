#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  historicalLocalizationInventoryDigest,
  validateHistoricalLocalizationInventory,
} from "./lib/manual-quarantine.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
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
const { data: synced, error: syncError } = await supabase.rpc(
  "sync_manual_quarantine_registry",
);
if (syncError) {
  console.error(`MANUAL_QUARANTINE_SYNC_FAILED ${syncError.message}`);
  process.exit(1);
}

let state = synced;
let historicalImport = null;
if (args["historical-report"]) {
  const reportPath = resolve(root, String(args["historical-report"]));
  if (!existsSync(reportPath)) {
    console.error(`MANUAL_QUARANTINE_HISTORY_FAILED missing_report=${reportPath}`);
    process.exit(1);
  }
  const rawReport = readFileSync(reportPath, "utf8");
  const report = JSON.parse(rawReport);
  const inventory = validateHistoricalLocalizationInventory(report);
  if (!inventory.complete) {
    console.error(
      `MANUAL_QUARANTINE_HISTORY_FAILED reason=${inventory.reason}`,
    );
    process.exit(1);
  }
  const sourceIds = inventory.sourceIds;
  const reportedAt = String(report.finished_at || report.started_at || "").trim();
  if (!reportedAt || !Number.isFinite(Date.parse(reportedAt))) {
    console.error("MANUAL_QUARANTINE_HISTORY_FAILED report_timestamp_missing_or_invalid");
    process.exit(1);
  }
  const reportDigest = historicalLocalizationInventoryDigest(report);
  const { data, error } = await supabase.rpc(
    "replace_manual_quarantine_historical_limitations",
    {
      p_source_ids: sourceIds,
      p_reported_at: new Date(reportedAt).toISOString(),
      p_report_digest: reportDigest,
    },
  );
  if (error) {
    console.error(`MANUAL_QUARANTINE_HISTORY_FAILED ${error.message}`);
    process.exit(1);
  }
  state = data;
  historicalImport = {
    source_count: sourceIds.length,
    report_path: reportPath,
    report_digest: reportDigest,
    reported_at: new Date(reportedAt).toISOString(),
  };
}

console.log("MANUAL_QUARANTINE_REGISTRY_SYNCED");
console.log(JSON.stringify({ state, historical_import: historicalImport }, null, 2));

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
