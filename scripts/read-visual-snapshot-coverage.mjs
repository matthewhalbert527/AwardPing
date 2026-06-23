#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const defaultArchiveRoot = "D:\\AwardPingVisualSnapshots";
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};
const archiveRoot = resolve(String(env.AWARDPING_VISUAL_SNAPSHOT_DIR || args["archive-dir"] || defaultArchiveRoot));
const brokenSourcesPath = resolve(
  String(args["broken-sources-path"] || join(archiveRoot, "broken-sources", "broken-sources-current.json")),
);
const limit = positiveInt(args.limit, 100_000);

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.log(JSON.stringify({ available: false, error: "Missing Supabase config" }));
  process.exit(0);
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);

try {
  const [sources, publishedSnapshotSourceIds] = await Promise.all([
    loadActiveSources(limit),
    loadPublishedSnapshotSourceIds(limit),
  ]);
  const knownBrokenSourceIds = loadKnownBrokenSourceIds(brokenSourcesPath);
  const missingSources = sources.filter((source) => !publishedSnapshotSourceIds.has(source.id));
  const knownBrokenMissing = missingSources.filter((source) => knownBrokenSourceIds.has(source.id));
  const actionableMissing = missingSources.filter((source) => !knownBrokenSourceIds.has(source.id));

  console.log(
    JSON.stringify({
      available: true,
      source: "database",
      sourceCount: sources.length,
      snapshotSourceCount: publishedSnapshotSourceIds.size,
      missingCount: missingSources.length,
      actionableMissingCount: actionableMissing.length,
      knownBrokenMissingCount: knownBrokenMissing.length,
      complete: actionableMissing.length === 0,
      brokenSourcesPath,
      sampleActionableMissing: actionableMissing.slice(0, 10).map((source) => ({
        id: source.id,
        shared_award_id: source.shared_award_id,
        url: source.url,
        title: source.title,
        last_error: source.last_error || null,
        consecutive_failures: source.consecutive_failures || 0,
      })),
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      available: false,
      error: error?.message || String(error),
    }),
  );
}

async function loadActiveSources(pageLimit) {
  const pageSize = Math.min(1_000, pageLimit);
  const rows = [];

  for (let from = 0; rows.length < pageLimit; from += pageSize) {
    const to = Math.min(from + pageSize - 1, pageLimit - 1);
    const { data, error } = await supabase
      .from("shared_award_sources")
      .select(
        "id, shared_award_id, url, title, consecutive_failures, last_error, created_at, shared_awards!inner(id, status)",
      )
      .eq("shared_awards.status", "active")
      .order("created_at", { ascending: true })
      .range(from, to);

    if (error) throw new Error(describeSupabaseError(error, "load active shared award sources"));

    const page = data || [];
    rows.push(...page);
    if (page.length < to - from + 1) break;
  }

  return rows.slice(0, pageLimit);
}

async function loadPublishedSnapshotSourceIds(pageLimit) {
  const pageSize = Math.min(1_000, pageLimit);
  const ids = new Set();

  for (let from = 0; from < pageLimit; from += pageSize) {
    const to = Math.min(from + pageSize - 1, pageLimit - 1);
    const { data, error } = await supabase
      .from("shared_award_source_visual_snapshots")
      .select("shared_award_source_id, latest_object_keys")
      .order("updated_at", { ascending: true })
      .range(from, to);

    if (error) throw new Error(describeSupabaseError(error, "load published visual snapshot records"));

    const page = data || [];
    for (const row of page) {
      if (Object.keys(jsonObjectOrEmpty(row.latest_object_keys)).length) {
        ids.add(row.shared_award_source_id);
      }
    }
    if (page.length < to - from + 1) break;
  }

  return ids;
}

function loadKnownBrokenSourceIds(path) {
  const ids = new Set();
  const current = readJsonIfExists(path) || {};
  for (const record of Object.values(current)) {
    if (record?.source_id) ids.add(record.source_id);
  }
  return ids;
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

function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function jsonObjectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function describeSupabaseError(error, action) {
  const message = error?.message || "Unknown Supabase error";
  const details = error?.details ? ` details=${error.details}` : "";
  const hint = error?.hint ? ` hint=${error.hint}` : "";
  return `Could not ${action}: ${message}${details}${hint}`;
}
