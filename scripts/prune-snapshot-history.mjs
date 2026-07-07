#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkSupabaseHealth } from "./lib/supabase-health.mjs";
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
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const apply = boolArg(args.apply, false);
const keep = positiveInt(args.keep, 2);
const batchSize = boundedInt(args["batch-size"], 10_000, 1, 100_000);
const maxBatches = positiveInt(args["max-batches"], apply ? 100 : 1);
const table = stringArg(args.table, "all").toLowerCase();
const preserveChangeEventSnapshots = !boolArg(args["delete-change-event-snapshots"], false);

const tasks = [];
if (table === "all" || table === "shared") {
  tasks.push({
    label: "shared_award_source_snapshots",
    rpc: "prune_shared_award_source_snapshot_history",
    params: {
      p_keep_per_source: keep,
      p_batch_size: batchSize,
      p_preserve_change_event_snapshots: preserveChangeEventSnapshots,
    },
  });
}
if (table === "all" || table === "monitor") {
  tasks.push({
    label: "monitor_snapshots",
    rpc: "prune_monitor_snapshot_history",
    params: {
      p_keep_per_monitor: keep,
      p_batch_size: batchSize,
      p_preserve_change_event_snapshots: preserveChangeEventSnapshots,
    },
  });
}

if (!tasks.length) {
  console.error("--table must be all, shared, or monitor.");
  process.exit(1);
}

const summary = {
  apply,
  keep,
  batch_size: batchSize,
  max_batches: maxBatches,
  preserve_change_event_snapshots: preserveChangeEventSnapshots,
  tables: {},
};

const health = await checkSupabaseHealth(supabase);
if (!health.ok) {
  summary.status = "blocked";
  summary.stop_reason = "supabase_unavailable";
  summary.supabase_health = health;
  console.log(`SUPABASE_UNAVAILABLE reason=${health.reason} message=${health.message}`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

for (const task of tasks) {
  summary.tables[task.label] = await runTask(task);
}

summary.status = "succeeded";
console.log(JSON.stringify(summary, null, 2));

async function runTask(task) {
  let candidateCount = 0;
  let deletedCount = 0;
  let batches = 0;

  while (batches < maxBatches) {
    batches += 1;
    const result = await callPruneRpc(task, apply);
    candidateCount += result.candidate_count;
    deletedCount += result.deleted_count;

    console.log(
      [
        "SNAPSHOT_PRUNE",
        `table=${task.label}`,
        `batch=${batches}`,
        `candidates=${result.candidate_count}`,
        `deleted=${result.deleted_count}`,
        `apply=${apply}`,
      ].join(" "),
    );

    if (!apply || result.candidate_count < batchSize || result.deleted_count === 0) {
      break;
    }
  }

  return {
    batches,
    candidate_count: candidateCount,
    deleted_count: deletedCount,
    maybe_more_remaining: apply && batches >= maxBatches,
  };
}

async function callPruneRpc(task, shouldApply) {
  const { data, error } = await supabase.rpc(task.rpc, {
    ...task.params,
    p_apply: shouldApply,
  });

  if (error) {
    throw new Error(
      [
        `Snapshot history prune RPC failed for ${task.label}: ${describeSupabaseError(error)}`,
        "Make sure migration 20260706180000_snapshot_history_retention.sql has been applied.",
      ].join(" "),
    );
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    candidate_count: nonNegativeInt(row?.candidate_count, 0),
    deleted_count: nonNegativeInt(row?.deleted_count, 0),
  };
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

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boundedInt(value, fallback, min, max) {
  return Math.min(Math.max(positiveInt(value, fallback), min), max);
}

function stringArg(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function describeSupabaseError(error) {
  return [
    error.message || "Unknown error",
    error.code ? `code=${error.code}` : "",
    error.details ? `details=${error.details}` : "",
    error.hint ? `hint=${error.hint}` : "",
  ].filter(Boolean).join(" ");
}
