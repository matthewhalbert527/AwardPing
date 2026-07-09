#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  sourceQualityDecision,
} from "./lib/source-quality.mjs";
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
const awardIdFilter = cleanText(args["award-id"]);
const sourceIdFilter = cleanText(args["source-id"]);
const limit = positiveInt(args.limit, 0);
const applyUpdates = boolArg(args.apply, false);

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);

async function run() {
  const startedAt = new Date().toISOString();
  const rows = await loadOpenSources();
  const report = {
    started_at: startedAt,
    finished_at: null,
    apply: applyUpdates,
    filters: {
      award_id: awardIdFilter || null,
      source_id: sourceIdFilter || null,
      limit: limit || "all",
    },
    loaded: rows.length,
    accepted: 0,
    rejected: 0,
    applied: 0,
    failed: 0,
    rejection_counts: {},
    examples: {},
    errors: [],
  };

  for (const source of rows) {
    const decision = sourceQualityDecision(source, { purpose: "monitoring" });
    if (decision.allowed) {
      report.accepted += 1;
      continue;
    }

    report.rejected += 1;
    report.rejection_counts[decision.reason] = (report.rejection_counts[decision.reason] || 0) + 1;
    if (!report.examples[decision.reason]) {
      report.examples[decision.reason] = [];
    }
    if (report.examples[decision.reason].length < 5) {
      report.examples[decision.reason].push({
        id: source.id,
        shared_award_id: source.shared_award_id,
        title: source.display_title || source.title || null,
        url: source.url,
      });
    }

    if (!applyUpdates) continue;

    const { error } = await supabase
      .from("shared_award_sources")
      .update({
        admin_review_status: "review_later",
        admin_review_note: truncate(
          `Auto-cleaned by source quality gate (${decision.reason}). This source is not eligible for public display, facts, or monitoring.`,
          1000,
        ),
        admin_reviewed_at: new Date().toISOString(),
        admin_reviewed_by: "cleanup-open-sources-by-baseline-facts",
        updated_at: new Date().toISOString(),
      })
      .eq("id", source.id)
      .eq("admin_review_status", "open");

    if (error) {
      report.failed += 1;
      report.errors.push({
        source_id: source.id,
        reason: decision.reason,
        message: error.message || String(error),
      });
    } else {
      report.applied += 1;
    }
  }

  report.finished_at = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
}

async function loadOpenSources() {
  const rows = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    let query = supabase
      .from("shared_award_sources")
      .select(
        "id, shared_award_id, url, title, display_title, page_description, page_metadata, page_metadata_generated_at, page_type, source, reason, submitted_by_user_id, admin_review_status, created_at",
      )
      .eq("admin_review_status", "open")
      .order("created_at", { ascending: true })
      .range(from, from + pageSize - 1);

    if (awardIdFilter) query = query.eq("shared_award_id", awardIdFilter);
    if (sourceIdFilter) query = query.eq("id", sourceIdFilter);

    const { data, error } = await query;
    if (error) throw new Error(`Load open sources failed: ${error.message}`);
    rows.push(...(data || []));
    if (limit && rows.length >= limit) return rows.slice(0, limit);
    if (!data || data.length < pageSize) break;
  }

  return rows;
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

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inlineValue] = value.slice(2).split("=");
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
    } else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[key] = values[index + 1];
      index += 1;
    } else {
      parsed[key] = "true";
    }
  }
  return parsed;
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).trim().toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanText(value) {
  return String(value || "").trim();
}

function truncate(value, maxLength) {
  const clean = cleanText(value).replace(/\s+/g, " ");
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3)}...`;
}

await run().catch((error) => {
  console.error(`SOURCE_QUALITY_CLEANUP_FATAL ${error.message || String(error)}`);
  process.exit(1);
});
