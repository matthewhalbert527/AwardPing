#!/usr/bin/env node
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMonitorableAwardSource } from "./lib/source-quality.mjs";
import {
  classifySnapshotLocalization,
  summarizeSnapshotLocalization,
} from "./lib/snapshot-localization.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env
  ? resolve(root, String(args.env))
  : existsSync(resolve(root, ".env.worker.local"))
    ? resolve(root, ".env.worker.local")
    : resolve(root, ".env.local");
const env = { ...loadEnvFile(envPath), ...process.env };
const apply = boolArg(args.apply, false);
const limit = positiveInt(args.limit, 100_000);
const concurrency = boundedInt(args.concurrency, 20, 1, 50);
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(reportDir, `snapshot-localization-coverage-${timestampForPath(new Date().toISOString())}.json`);
const latestReportPath = join(reportDir, "snapshot-localization-coverage-latest.json");

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const r2AccountId = cleanText(args["r2-account-id"] || env.R2_ACCOUNT_ID);
const r2Endpoint = cleanText(
  args["r2-endpoint"] || env.R2_ENDPOINT || (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : ""),
);
const r2Bucket = cleanText(args["r2-bucket"] || env.R2_BUCKET || "awardping-snapshots");
const r2AccessKeyId = cleanText(args["r2-access-key-id"] || env.R2_ACCESS_KEY_ID);
const r2SecretAccessKey = cleanText(args["r2-secret-access-key"] || env.R2_SECRET_ACCESS_KEY);

if (!supabaseUrl || !serviceRoleKey) fail("Supabase worker configuration is required.");
if (!r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey) fail("Cloudflare R2 worker configuration is required.");

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const r2 = new S3Client({
  region: "auto",
  endpoint: r2Endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey },
});
const startedAt = new Date().toISOString();

try {
  const sources = (await loadRows(
    "shared_award_sources",
    "id,shared_award_id,url,title,display_title,page_description,page_metadata,page_metadata_generated_at,page_metadata_model,page_type,source,reason,submitted_by_user_id,admin_review_status,created_at,shared_awards!inner(id,name,status,official_homepage)",
    (query) => query.eq("admin_review_status", "open").eq("shared_awards.status", "active"),
    { limit },
  )).filter((source) => isMonitorableAwardSource(source));
  const snapshots = await loadSnapshots(sources.map((source) => source.id));
  const snapshotBySource = new Map(snapshots.map((snapshot) => [snapshot.shared_award_source_id, snapshot]));
  const rows = [];

  await promisePool(sources, concurrency, async (source) => {
    const snapshot = snapshotBySource.get(source.id) || {};
    const latestMetaResult = await readMeta(snapshot.latest_object_keys);
    const previousMetaResult = await readMeta(snapshot.previous_object_keys);
    const latest = classifySnapshotLocalization({
      version: "latest",
      objectKeys: snapshot.latest_object_keys,
      hashes: snapshot.latest_hashes,
      meta: latestMetaResult.meta,
      metaError: latestMetaResult.error,
      recordMetadata: snapshot.latest_metadata,
      peerHashes: snapshot.previous_hashes,
      peerMeta: previousMetaResult.meta,
    });
    const previous = classifySnapshotLocalization({
      version: "previous",
      objectKeys: snapshot.previous_object_keys,
      hashes: snapshot.previous_hashes,
      meta: previousMetaResult.meta,
      metaError: previousMetaResult.error,
      recordMetadata: snapshot.previous_metadata,
      peerHashes: snapshot.latest_hashes,
      peerMeta: latestMetaResult.meta,
    });
    const row = {
      source_id: source.id,
      shared_award_id: source.shared_award_id,
      source_url: source.url,
      latest,
      previous,
    };
    rows.push(row);
    if (apply && snapshot.shared_award_source_id) {
      await persistLocalizationAudit(snapshot, latest, previous);
    }
  });

  const summary = summarizeSnapshotLocalization(rows);
  const report = {
    version: 1,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    apply,
    ...summary,
    repair_source_ids: rows
      .filter((row) => row.latest.repair_needed || row.previous.repair_needed)
      .map((row) => row.source_id),
    samples: {
      repair_needed: rows.filter((row) => row.latest.repair_needed || row.previous.repair_needed).slice(0, 20),
      historical_layout_unavailable: rows
        .filter((row) => row.previous.status === "historical_layout_unavailable")
        .slice(0, 20),
    },
  };
  atomicWriteJson(reportPath, report);
  atomicWriteJson(latestReportPath, report);
  console.log(`SNAPSHOT_LOCALIZATION_COVERAGE_REPORT ${reportPath}`);
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(`SNAPSHOT_LOCALIZATION_COVERAGE_FAILED ${errorMessage(error)}`);
  process.exitCode = 1;
}

async function loadSnapshots(sourceIds) {
  const rows = [];
  for (let index = 0; index < sourceIds.length; index += 100) {
    const ids = sourceIds.slice(index, index + 100);
    if (!ids.length) continue;
    const { data, error } = await supabase
      .from("shared_award_source_visual_snapshots")
      .select("shared_award_source_id,latest_object_keys,latest_hashes,latest_metadata,previous_object_keys,previous_hashes,previous_metadata")
      .in("shared_award_source_id", ids);
    if (error) throw new Error(`Load visual snapshots failed: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

async function readMeta(objectKeys) {
  const key = cleanText(objectValue(objectKeys).meta);
  if (!key) return { meta: null, error: null };
  try {
    const response = await r2.send(new GetObjectCommand({ Bucket: r2Bucket, Key: key }));
    const text = await response.Body?.transformToString();
    return { meta: text ? JSON.parse(text) : null, error: null };
  } catch (error) {
    return { meta: null, error: errorMessage(error) };
  }
}

async function persistLocalizationAudit(snapshot, latest, previous) {
  const auditedAt = new Date().toISOString();
  const latestMetadata = {
    ...objectValue(snapshot.latest_metadata),
    localization: localizationMetadata(latest, auditedAt),
  };
  const previousMetadata = {
    ...objectValue(snapshot.previous_metadata),
    localization: localizationMetadata(previous, auditedAt),
  };
  const { error } = await supabase
    .from("shared_award_source_visual_snapshots")
    .update({ latest_metadata: latestMetadata, previous_metadata: previousMetadata })
    .eq("shared_award_source_id", snapshot.shared_award_source_id);
  if (error) throw new Error(`Persist localization audit failed: ${error.message}`);
}

function localizationMetadata(result, auditedAt) {
  return {
    status: result.status,
    reason: result.reason,
    exact: result.exact,
    accounted_for: result.accounted_for,
    repair_needed: result.repair_needed,
    audited_at: auditedAt,
  };
}

async function loadRows(table, select, configure = null, options = {}) {
  const rows = [];
  const pageSize = 1_000;
  const rowLimit = options.limit || 100_000;
  for (let from = 0; rows.length < rowLimit; from += pageSize) {
    let query = supabase.from(table).select(select);
    if (configure) query = configure(query);
    const { data, error } = await query
      .order("id", { ascending: true })
      .range(from, Math.min(from + pageSize - 1, rowLimit - 1));
    if (error) throw new Error(`Load ${table} failed: ${error.message}`);
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.slice(0, rowLimit);
}

async function promisePool(items, concurrencyValue, worker) {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrencyValue, Math.max(1, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
    else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[withoutPrefix] = values[index + 1];
      index += 1;
    } else parsed[withoutPrefix] = "true";
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

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  renameSync(temporary, path);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boolArg(value, fallback) {
  if (value === undefined) return fallback;
  return !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function boundedInt(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function timestampForPath(value) {
  return String(value).replace(/[:.]/g, "-");
}

function errorMessage(error) {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error || "Unknown error");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
