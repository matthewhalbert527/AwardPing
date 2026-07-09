#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env
  ? resolve(root, String(args.env))
  : existsSync(resolve(root, ".env.worker.local"))
    ? resolve(root, ".env.worker.local")
    : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const supabase = createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const statuses = ["pending", "submitted", "processing", "succeeded", "rejected", "failed", "published", "superseded"];
const report = {
  checked_at: new Date().toISOString(),
  env_path: envPath,
  status_counts: {},
  submitted_jobs: 0,
  processing_jobs: 0,
  estimated_batch_cost_usd: 0,
  actual_usage: {
    prompt_tokens: 0,
    candidates_tokens: 0,
    total_tokens: 0,
    thoughts_tokens: 0,
    cached_content_tokens: 0,
  },
  recent_batches: [],
};

for (const status of statuses) {
  const { count, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("id", { count: "exact", head: true })
    .eq("status", status);
  if (error) throw new Error(`Count visual review candidates status=${status} failed: ${error.message}`);
  report.status_counts[status] = count || 0;
}

const { data: activeRows, error: activeError } = await supabase
  .from("shared_award_visual_review_candidates")
  .select("gemini_batch_name,status,model,submitted_at,estimated_cost_usd,actual_usage")
  .in("status", ["submitted", "processing", "succeeded", "published", "rejected", "failed"])
  .not("gemini_batch_name", "is", null)
  .order("submitted_at", { ascending: false })
  .limit(5000);

if (activeError) throw new Error(`Load visual review batch rows failed: ${activeError.message}`);

const batches = new Map();
for (const row of activeRows || []) {
  if (row.status === "submitted") report.submitted_jobs += 1;
  if (row.status === "processing") report.processing_jobs += 1;
  report.estimated_batch_cost_usd += Number(row.estimated_cost_usd || 0);
  addUsage(report.actual_usage, row.actual_usage);
  if (!row.gemini_batch_name) continue;
  if (!batches.has(row.gemini_batch_name)) {
    batches.set(row.gemini_batch_name, {
      name: row.gemini_batch_name,
      model: row.model || null,
      submitted_at: row.submitted_at || null,
      counts: {},
    });
  }
  const batch = batches.get(row.gemini_batch_name);
  batch.counts[row.status] = (batch.counts[row.status] || 0) + 1;
}

report.submitted_jobs = [...batches.values()].filter((batch) => batch.counts.submitted).length;
report.processing_jobs = [...batches.values()].filter((batch) => batch.counts.processing).length;
report.estimated_batch_cost_usd = roundUsd(report.estimated_batch_cost_usd);
report.recent_batches = [...batches.values()].slice(0, 25);

console.log(JSON.stringify(report, null, 2));

function addUsage(target, usage) {
  if (!usage || typeof usage !== "object") return;
  target.prompt_tokens += nonNegativeInt(usage.prompt_tokens, 0);
  target.candidates_tokens += nonNegativeInt(usage.candidates_tokens, 0);
  target.total_tokens += nonNegativeInt(usage.total_tokens, 0);
  target.thoughts_tokens += nonNegativeInt(usage.thoughts_tokens, 0);
  target.cached_content_tokens += nonNegativeInt(usage.cached_content_tokens, 0);
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

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function roundUsd(value) {
  return Math.round(Math.max(0, Number(value) || 0) * 1_000_000) / 1_000_000;
}
