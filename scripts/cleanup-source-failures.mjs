#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";
import {
  classifySourceHygiene,
  shouldAutoReviewLaterFailure,
} from "./source-hygiene.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const archiveRoot = resolve(String(env.AWARDPING_VISUAL_SNAPSHOT_DIR || args["archive-dir"] || "D:\\AwardPingVisualSnapshots"));
const brokenSourcesPath = resolve(String(args["broken-sources"] || `${archiveRoot}\\broken-sources\\broken-sources-current.json`));
const dryRun = boolArg(args["dry-run"], false);
const includeObviousActive = boolArg(args["include-obvious-active"], false);
const limit = positiveInt(args.limit, 20_000);
const batchSize = positiveInt(args["batch-size"], 200);
const createdSince = String(args["created-since"] || "").trim();
const reasonFilter = new Set(
  String(args.reasons || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const supabase = createSupabaseServiceClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
);

const now = new Date().toISOString();
const brokenRecords = loadBrokenRecords(brokenSourcesPath);
const brokenBySourceId = new Map(
  brokenRecords
    .filter((record) => record.source_id)
    .map((record) => [record.source_id, record]),
);

const activeOpenSources = await loadActiveOpenSources(limit);
const candidates = [];

for (const source of activeOpenSources) {
  const broken = brokenBySourceId.get(source.id) || null;
  if (!broken && !includeObviousActive) continue;
  const hygiene = broken
    ? shouldAutoReviewLaterFailure(
        {
          ...source,
          award_name: source.shared_awards?.name || broken.award_name || "",
          source_url: source.url,
          source_title: source.title,
        },
        {
          failure_type: broken.failure_type,
          status_code: broken.status_code,
          message: broken.error_message || source.last_error || "",
        },
      )
    : classifySourceHygiene({
        ...source,
        award_name: source.shared_awards?.name || "",
      });

  if (hygiene.action !== "review_later") continue;
  if (reasonFilter.size > 0 && !reasonFilter.has(hygiene.reason)) continue;

  candidates.push({
    id: source.id,
    shared_award_id: source.shared_award_id,
    url: source.url,
    title: source.title,
    created_at: source.created_at,
    award_name: source.shared_awards?.name || broken?.award_name || "",
    reason: hygiene.reason,
    note: hygiene.note,
    failure_type: broken?.failure_type || null,
    status_code: broken?.status_code || null,
  });
}

const summary = candidates.reduce((acc, candidate) => {
  acc[candidate.reason] = (acc[candidate.reason] || 0) + 1;
  return acc;
}, {});

console.log(
  JSON.stringify(
    {
      dry_run: dryRun,
      active_open_sources_loaded: activeOpenSources.length,
      broken_records_loaded: brokenRecords.length,
      include_obvious_active: includeObviousActive,
      created_since: createdSince || null,
      reasons_filter: [...reasonFilter],
      review_later_candidates: candidates.length,
      reasons: summary,
      sample: candidates.slice(0, 20).map((candidate) => ({
        award: candidate.award_name,
        title: candidate.title,
        reason: candidate.reason,
        failure_type: candidate.failure_type,
        status_code: candidate.status_code,
        created_at: candidate.created_at,
        url: candidate.url,
      })),
    },
    null,
    2,
  ),
);

if (!dryRun && candidates.length) {
  let updated = 0;
  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    const ids = batch.map((candidate) => candidate.id);
    const { error } = await supabase
      .from("shared_award_sources")
      .update({
        admin_review_status: "review_later",
        admin_review_note: "Auto-cleaned from daily scan: permanent, blocked, private, oversized, social/share, or non-award source failure.",
        admin_reviewed_at: now,
        admin_reviewed_by: "awardping-cleanup",
        updated_at: now,
      })
      .in("id", ids);

    if (error) throw new Error(`shared_award_sources cleanup update failed: ${error.message}`);
    updated += batch.length;
    console.log(`UPDATED review_later ${updated}/${candidates.length}`);
  }
}

if (!dryRun && candidates.length && existsSync(brokenSourcesPath)) {
  const reviewedIds = new Set(candidates.map((candidate) => candidate.id));
  const current = readJsonIfExists(brokenSourcesPath) || {};
  for (const [key, record] of Object.entries(current)) {
    if (reviewedIds.has(record?.source_id)) {
      current[key] = {
        ...record,
        admin_review_status: "review_later",
        auto_cleaned_at: now,
      };
    }
  }
  writeFileSync(brokenSourcesPath, JSON.stringify(current, null, 2), "utf8");
}

const remaining = dryRun ? null : await countActiveOpenSources();
console.log(
  JSON.stringify(
    {
      dry_run: dryRun,
      updated_review_later: dryRun ? 0 : candidates.length,
      active_open_sources_remaining: remaining,
    },
    null,
    2,
  ),
);

async function loadActiveOpenSources(pageLimit) {
  const rows = [];
  const pageSize = 1000;

  for (let from = 0; rows.length < pageLimit; from += pageSize) {
    const to = from + pageSize - 1;
    let query = supabase
      .from("shared_award_sources")
      .select(
        "id,shared_award_id,url,title,page_type,reason,last_error,consecutive_failures,admin_review_status,created_at,shared_awards!inner(id,name,status)",
      )
      .eq("admin_review_status", "open")
      .eq("shared_awards.status", "active");

    if (createdSince) {
      query = query.gte("created_at", createdSince);
    }

    const { data, error } = await query.range(from, to);

    if (error) throw new Error(`load shared_award_sources failed: ${error.message}`);
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  return rows.slice(0, pageLimit);
}

async function countActiveOpenSources() {
  const { count, error } = await supabase
    .from("shared_award_sources")
    .select("id,shared_awards!inner(id,status)", { count: "exact", head: true })
    .eq("admin_review_status", "open")
    .eq("shared_awards.status", "active");

  if (error) throw new Error(`count shared_award_sources failed: ${error.message}`);
  return count || 0;
}

function loadBrokenRecords(path) {
  const current = readJsonIfExists(path) || {};
  return Object.values(current).filter(Boolean);
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    if (!value.startsWith("--")) continue;
    const [key, ...rest] = value.slice(2).split("=");
    parsed[key] = rest.length ? rest.join("=") : true;
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
  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
