#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.log(JSON.stringify({ available: false, error: "Missing Supabase config" }));
  process.exit(0);
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const { data, error } = await supabase
  .from("local_worker_runs")
  .select("id,status,started_at,finished_at,checked_count,initial_count,changed_count,failed_count,metadata,error")
  .eq("worker_name", "local-baseline-facts-worker")
  .order("started_at", { ascending: false })
  .limit(1)
  .maybeSingle();

if (error || !data) {
  console.log(JSON.stringify({ available: false, error: error?.message || "No run found" }));
  process.exit(0);
}

const metadata = objectValue(data.metadata);
const counts = objectValue(metadata.counts);
const pipeline = objectValue(metadata.visual_pipeline);
const extraction = objectValue(pipeline.extraction);
const usage = objectValue(metadata.gemini_usage);
const loaded = numberValue(counts.loaded_baselines);
const extracted = numberValue(extraction.extracted || counts.extracted || data.initial_count);
const skippedExisting = numberValue(counts.skipped_existing);
const skippedIneligible = numberValue(counts.skipped_ineligible);
const failed = numberValue(extraction.failed || counts.failed || data.failed_count);
const processed = extracted + skippedExisting + skippedIneligible;
const stopReason = stringValue(metadata.stop_reason);
const startedDay = data.started_at ? localDay(data.started_at) : "";
const today = localDay(new Date().toISOString());

console.log(
  JSON.stringify({
    available: true,
    source: "database",
    latestReport: `db:${data.id}`,
    runId: data.id,
    status: data.status,
    loaded,
    processed,
    extracted,
    skippedExisting,
    skippedIneligible,
    failed,
    stopReason,
    complete: loaded > 0 && processed >= loaded && failed === 0,
    drained: loaded > 0 && processed + failed >= loaded,
    pausedForCostCapToday:
      stopReason === "gemini_api_cost_cap_reached" && startedDay === today,
    running: data.status === "running",
    calls: numberValue(usage.calls),
    estimatedCostUsd: numberFloatValue(usage.estimated_cost_usd),
  }),
);

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
  if (!existsSync(path)) return {};
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

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function numberFloatValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function localDay(value) {
  return new Date(value).toLocaleDateString("en-CA");
}
