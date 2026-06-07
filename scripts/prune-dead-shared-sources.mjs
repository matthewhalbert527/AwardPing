#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, args.env) : resolve(root, ".env.local");
const env = { ...loadEnvFile(envPath), ...process.env };
const apply = args.apply === true || args.apply === "true";
const minFailures = positiveInt(args["min-failures"], 3);
const limit = positiveInt(args.limit, 0);
const outputPath =
  args.output ||
  join(root, "reports", `dead-shared-sources-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createSupabaseServiceClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
);

console.log(
  `Pruning dead shared source URLs; apply=${apply}; minFailures=${minFailures}; limit=${limit || "all"}; env=${envPath}.`,
);

const [awards, sources, snapshots, events, awardSources, monitors] = await Promise.all([
  loadAll("shared_awards", "id,name,status"),
  loadAll(
    "shared_award_sources",
    "id,shared_award_id,url,title,page_type,source,last_hash,last_checked_at,consecutive_failures,last_error,created_at,updated_at",
  ),
  loadAll("shared_award_source_snapshots", "id,shared_award_source_id"),
  loadAll("shared_award_change_events", "id,shared_award_source_id"),
  loadAll("award_sources", "id,shared_award_source_id"),
  loadAll("monitors", "id,shared_award_source_id"),
]);

const activeAwardIds = new Set(awards.filter((award) => award.status === "active").map((award) => award.id));
const awardNames = new Map(awards.map((award) => [award.id, award.name]));
const snapshotCounts = countById(snapshots, "shared_award_source_id");
const eventCounts = countById(events, "shared_award_source_id");
const awardSourceCounts = countById(awardSources, "shared_award_source_id");
const monitorCounts = countById(monitors, "shared_award_source_id");

const activeSources = sources.filter((source) => activeAwardIds.has(source.shared_award_id));
const candidates = activeSources
  .filter((source) => isDeletionCandidate(source))
  .sort((left, right) => {
    const awardDelta = String(awardNames.get(left.shared_award_id) || "").localeCompare(
      String(awardNames.get(right.shared_award_id) || ""),
    );
    if (awardDelta !== 0) return awardDelta;
    return left.url.localeCompare(right.url);
  });
const limitedCandidates = limit > 0 ? candidates.slice(0, limit) : candidates;

const report = {
  generatedAt: new Date().toISOString(),
  apply,
  minFailures,
  activeSourceCount: activeSources.length,
  candidateCount: candidates.length,
  appliedCount: 0,
  candidates: limitedCandidates.map((source) => ({
    id: source.id,
    awardId: source.shared_award_id,
    awardName: awardNames.get(source.shared_award_id),
    title: source.title,
    url: source.url,
    pageType: source.page_type,
    source: source.source,
    consecutiveFailures: source.consecutive_failures,
    lastCheckedAt: source.last_checked_at,
    lastError: source.last_error,
    createdAt: source.created_at,
    updatedAt: source.updated_at,
  })),
};

if (apply && limitedCandidates.length > 0) {
  for (const batch of chunk(limitedCandidates, 100)) {
    const { error } = await supabase
      .from("shared_award_sources")
      .delete()
      .in(
        "id",
        batch.map((source) => source.id),
      );
    if (error) throw new Error(`shared_award_sources delete failed: ${error.message}`);
    report.appliedCount += batch.length;
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ outputPath, ...report, candidates: undefined }, null, 2));

function isDeletionCandidate(source) {
  return (
    !source.last_hash &&
    Boolean(source.last_error) &&
    (source.consecutive_failures || 0) >= minFailures &&
    !snapshotCounts.has(source.id) &&
    !eventCounts.has(source.id) &&
    !awardSourceCounts.has(source.id) &&
    !monitorCounts.has(source.id)
  );
}

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

function countById(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const id = row[key];
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const raw = value.slice(2);
    if (raw.includes("=")) {
      const [key, ...rest] = raw.split("=");
      parsed[key] = rest.join("=");
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[raw] = next;
      index += 1;
    } else {
      parsed[raw] = true;
    }
  }
  return parsed;
}

function loadEnvFile(path) {
  try {
    const envFile = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      envFile[key] = value;
    }
    return envFile;
  } catch {
    return {};
  }
}
