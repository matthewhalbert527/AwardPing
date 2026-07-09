#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { changeEventSuppressionDecision } from "./lib/change-event-suppression.mjs";
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
const applyUpdates = boolArg(args.apply, false);
const awardIdFilter = cleanText(args["award-id"]);
const sourceIdFilter = cleanText(args["source-id"]);
const limit = positiveInt(args.limit, 10_000);
const batchSize = positiveInt(args["batch-size"], 500);
const suppressionSource = cleanText(args["suppression-source"]) || "cleanup-change-event-noise";

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);

await run().catch((error) => {
  console.error(`CHANGE_EVENT_NOISE_CLEANUP_FATAL ${error.message || String(error)}`);
  process.exit(1);
});

async function run() {
  const startedAt = new Date().toISOString();
  const events = await loadCandidateEvents();
  const sources = await loadSourcesForEvents(events);
  const report = {
    started_at: startedAt,
    finished_at: null,
    apply: applyUpdates,
    filters: {
      award_id: awardIdFilter || null,
      source_id: sourceIdFilter || null,
      limit,
    },
    loaded_events: events.length,
    suppressible_events: 0,
    kept_events: 0,
    applied: 0,
    failed: 0,
    reason_counts: {},
    examples: {},
    errors: [],
  };

  const suppressible = [];
  for (const event of events) {
    const source = event.shared_award_source_id ? sources.get(event.shared_award_source_id) || null : null;
    const decision = changeEventSuppressionDecision(event, source);
    if (!decision.suppressed) {
      report.kept_events += 1;
      continue;
    }

    report.suppressible_events += 1;
    suppressible.push({ event, decision });
    increment(report.reason_counts, decision.reason || "suppressed");
    addExample(report.examples, decision.reason || "suppressed", event, source);
  }

  if (applyUpdates && suppressible.length) {
    const now = new Date().toISOString();
    for (const group of chunks(suppressible, 100)) {
      const ids = group.map(({ event }) => event.id);
      const reasonById = new Map(group.map(({ event, decision }) => [event.id, decision.reason || "suppressed"]));
      for (const { event, decision } of group) {
        const { error } = await supabase
          .from("shared_award_change_events")
          .update({
            suppressed_at: now,
            suppression_reason: decision.reason || "suppressed",
            suppression_source: suppressionSource,
          })
          .eq("id", event.id)
          .is("suppressed_at", null);

        if (error) {
          report.failed += 1;
          report.errors.push({
            event_id: event.id,
            reason: reasonById.get(event.id),
            message: error.message || String(error),
          });
        } else {
          report.applied += 1;
        }
      }

      if (!ids.length) break;
    }
  }

  report.finished_at = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
}

async function loadCandidateEvents() {
  const rows = [];
  for (let from = 0; rows.length < limit; from += batchSize) {
    let query = supabase
      .from("shared_award_change_events")
      .select(
        "id,shared_award_id,shared_award_source_id,source_title,source_url,source_page_type,summary,change_details,detected_at,suppressed_at,suppression_reason,suppression_source",
      )
      .is("suppressed_at", null)
      .order("detected_at", { ascending: false })
      .range(from, Math.min(from + batchSize - 1, limit - 1));

    if (awardIdFilter) query = query.eq("shared_award_id", awardIdFilter);
    if (sourceIdFilter) query = query.eq("shared_award_source_id", sourceIdFilter);

    const { data, error } = await withRetry(() => query);
    if (error) throw new Error(`Load change events failed: ${error.message || JSON.stringify(error)}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < batchSize) break;
  }
  return rows.slice(0, limit);
}

async function loadSourcesForEvents(events) {
  const ids = unique(events.map((event) => event.shared_award_source_id).filter(Boolean));
  const sources = new Map();
  for (const chunk of chunks(ids, 250)) {
    const { data, error } = await withRetry(() =>
      supabase
        .from("shared_award_sources")
        .select(
          "id,shared_award_id,url,title,display_title,page_description,page_metadata,page_metadata_generated_at,page_metadata_model,page_type,source,reason,submitted_by_user_id,admin_review_status",
        )
        .in("id", chunk),
    );
    if (error) throw new Error(`Load source lookup failed: ${error.message || JSON.stringify(error)}`);
    for (const source of data || []) sources.set(source.id, source);
  }
  return sources;
}

async function withRetry(fn, attempts = 4) {
  let lastResult = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResult = await fn();
    if (!lastResult?.error) return lastResult;
    const message = String(lastResult.error.message || "");
    const retryable =
      lastResult.error.code === "PGRST002" ||
      /\b(?:PGRST002|schema cache|timeout|fetch failed|503)\b/i.test(message);
    if (!retryable || attempt === attempts) return lastResult;
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
  return lastResult;
}

function addExample(examples, reason, event, source) {
  if (!examples[reason]) examples[reason] = [];
  if (examples[reason].length >= 5) return;
  examples[reason].push({
    event_id: event.id,
    award_id: event.shared_award_id,
    source_id: event.shared_award_source_id,
    source_status: source?.admin_review_status || null,
    source_title: event.source_title || source?.display_title || source?.title || null,
    source_url: event.source_url || source?.url || null,
    detected_at: event.detected_at,
    summary: event.summary,
  });
}

function increment(object, key) {
  object[key] = (object[key] || 0) + 1;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function unique(values) {
  return [...new Set(values)];
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
  const clean = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(clean)) return true;
  if (["0", "false", "no", "n"].includes(clean)) return false;
  return fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanText(value) {
  return String(value || "").trim();
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
