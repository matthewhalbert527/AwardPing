#!/usr/bin/env node
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildChangeEventVisualEvidenceCoverageReport,
  verifyChangeEventManifestArtifacts,
} from "./lib/event-visual-evidence-coverage.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env
  ? resolve(root, String(args.env))
  : existsSync(resolve(root, ".env.worker.local"))
    ? resolve(root, ".env.worker.local")
    : resolve(root, ".env.local");
const env = { ...loadEnvFile(envPath), ...process.env };
const limit = positiveInt(args.limit, 100_000);
const pageSize = boundedInt(args["page-size"], 500, 1, 1_000);
const concurrency = boundedInt(args.concurrency, 20, 1, 50);
const afterId = cleanText(args["after-id"]) || null;
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(reportDir, `event-visual-evidence-coverage-${timestampForPath(new Date().toISOString())}.json`);
const latestReportPath = join(reportDir, "event-visual-evidence-coverage-latest.json");

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const r2AccountId = cleanText(args["r2-account-id"] || env.R2_ACCOUNT_ID);
const r2Endpoint = cleanText(
  args["r2-endpoint"] || env.R2_ENDPOINT ||
  (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : ""),
);
const r2AccessKeyId = cleanText(args["r2-access-key-id"] || env.R2_ACCESS_KEY_ID);
const r2SecretAccessKey = cleanText(args["r2-secret-access-key"] || env.R2_SECRET_ACCESS_KEY);

if (!supabaseUrl || !serviceRoleKey) fail("Supabase worker configuration is required.");
if (!r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey) {
  fail("Cloudflare R2 worker configuration is required.");
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const r2 = new S3Client({
  region: "auto",
  endpoint: r2Endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey },
});
const startedAt = new Date().toISOString();

try {
  const events = await loadEvents();
  const evidenceRows = await loadEvidence(events.map((event) => event.id));
  const evidenceByEvent = new Map(evidenceRows.map((evidence) => [evidence.change_event_id, evidence]));
  const artifactChecksByEvent = new Map();
  const artifactCheckDetails = new Map();

  await promisePool(evidenceRows, concurrency, async (evidence) => {
    const result = await verifyChangeEventManifestArtifacts({
      evidence,
      headObject: async ({ bucket, key }) => {
        const response = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          byte_length: Number(response.ContentLength || 0),
          sha256: cleanText(response.Metadata?.sha256) || null,
          content_type: cleanText(response.ContentType) || null,
        };
      },
    });
    artifactChecksByEvent.set(evidence.change_event_id, result.checks);
    artifactCheckDetails.set(evidence.change_event_id, result.artifacts);
  });

  const coverage = buildChangeEventVisualEvidenceCoverageReport({
    events,
    evidenceByEvent,
    artifactChecksByEvent,
  });
  const artifactStatusCounts = {};
  for (const artifacts of artifactCheckDetails.values()) {
    for (const artifact of artifacts) increment(artifactStatusCounts, artifact.status || "unknown");
  }
  const failedArtifactSamples = [];
  for (const [eventId, artifacts] of artifactCheckDetails) {
    for (const artifact of artifacts) {
      if (["verified", "not_present"].includes(artifact?.status)) continue;
      if (failedArtifactSamples.length < 30) {
        failedArtifactSamples.push({ event_id: eventId, ...artifact });
      }
    }
  }

  const report = {
    version: 1,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    after_id: afterId,
    limit,
    truncated: events.length >= limit,
    artifact_check_status: artifactStatusCounts,
    ...coverage,
    samples: {
      failed_artifact_checks: failedArtifactSamples,
      missing_evidence: coverage.rows.filter((row) => !row.immutable_binding).slice(0, 30),
      full_fallback: coverage.rows.filter((row) =>
        Object.values(row.sides || {}).some((side) => side.retained_full && !side.verified_crop),
      ).slice(0, 30),
    },
  };
  atomicWriteJson(reportPath, report);
  atomicWriteJson(latestReportPath, report);
  console.log(`EVENT_VISUAL_EVIDENCE_COVERAGE_REPORT ${reportPath}`);
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(`EVENT_VISUAL_EVIDENCE_COVERAGE_FAILED ${errorMessage(error)}`);
  process.exitCode = 1;
} finally {
  r2.destroy();
}

async function loadEvents() {
  const rows = [];
  let cursor = afterId;
  while (rows.length < limit) {
    const count = Math.min(pageSize, limit - rows.length);
    let query = supabase
      .from("shared_award_change_events")
      .select("id,shared_award_id,shared_award_source_id,change_details,suppressed_at,detected_at")
      .order("id", { ascending: true })
      .limit(count);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw new Error(`Load change-event coverage page failed: ${error.message}`);
    const page = data || [];
    rows.push(...page);
    if (!page.length || page.length < count) break;
    cursor = page.at(-1).id;
  }
  return rows.slice(0, limit);
}

async function loadEvidence(eventIds) {
  const rows = [];
  for (const ids of chunks(eventIds, 100)) {
    const { data, error } = await supabase
      .from("shared_award_change_event_visual_evidence")
      .select(
        "change_event_id,shared_award_id,shared_award_source_id,visual_review_candidate_id,candidate_signature,bucket,evidence_status,previous_capture,current_capture,localization,evidence_schema_version,created_at,verified_at,backfilled_at",
      )
      .in("change_event_id", ids);
    if (error) throw new Error(`Load change-event evidence coverage rows failed: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function promisePool(items, concurrency, worker) {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

function increment(record, key) {
  const cleanKey = cleanText(key) || "unknown";
  record[cleanKey] = (record[cleanKey] || 0) + 1;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const argument = value.slice(2);
    const equalsIndex = argument.indexOf("=");
    if (equalsIndex !== -1) parsed[argument.slice(0, equalsIndex)] = argument.slice(equalsIndex + 1);
    else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[argument] = values[index + 1];
      index += 1;
    } else parsed[argument] = "true";
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

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
