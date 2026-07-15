#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const apply = boolArg(args.apply, false);
const limit = positiveInt(args.limit, 10_000);
const batchSize = positiveInt(args["batch-size"], 200);
const outputPath = resolve(
  root,
  args.output || "reports/roster-retrieval-update-noise-cleanup.json",
);

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const now = new Date().toISOString();

const candidateEvents = await loadCandidateEvents();
const likelyNoiseEvents = candidateEvents.filter(isRosterRetrievalNoiseEvent);
const sourceIdsToQuarantine = unique(
  likelyNoiseEvents
    .filter((event) => sourceLooksQuarantinable(event))
    .map((event) => event.shared_award_source_id)
    .filter(Boolean),
);

const awardIds = unique(likelyNoiseEvents.map((event) => event.shared_award_id).filter(Boolean));
const sourceIds = unique(likelyNoiseEvents.map((event) => event.shared_award_source_id).filter(Boolean));
const awards = await loadRowsById("shared_awards", awardIds, "id,name,slug");
const sources = await loadRowsById(
  "shared_award_sources",
  sourceIds,
  "id,title,display_title,url,page_type,admin_review_status",
);

let suppressedEvents = 0;
let markedSourcesReviewLater = 0;
if (apply) {
  suppressedEvents = await suppressEventRowsByIds(likelyNoiseEvents.map((event) => event.id));
  markedSourcesReviewLater = await markSourcesReviewLater(sourceIdsToQuarantine);
}

const byAward = new Map();
for (const event of likelyNoiseEvents) {
  const award = awards.get(event.shared_award_id) || {};
  const source = sources.get(event.shared_award_source_id) || {};
  if (!byAward.has(event.shared_award_id)) {
    byAward.set(event.shared_award_id, {
      award_id: event.shared_award_id,
      award_name: award.name || null,
      award_slug: award.slug || null,
      events: 0,
      sources: new Map(),
    });
  }
  const row = byAward.get(event.shared_award_id);
  row.events += 1;
  row.sources.set(event.shared_award_source_id, {
    source_id: event.shared_award_source_id,
    source_title: source.display_title || source.title || event.source_title || null,
    source_url: source.url || event.source_url || null,
    admin_review_status: source.admin_review_status || null,
  });
}

const report = {
  generated_at: now,
  apply,
  scanned_candidate_events: candidateEvents.length,
  likely_roster_retrieval_noise_events: likelyNoiseEvents.length,
  sources_to_quarantine: sourceIdsToQuarantine.length,
  deleted_events: 0,
  suppressed_events: suppressedEvents,
  marked_sources_review_later: markedSourcesReviewLater,
  awards: [...byAward.values()].map((row) => ({
    ...row,
    sources: [...row.sources.values()],
  })),
  events: likelyNoiseEvents.map((event) => ({
    id: event.id,
    award_id: event.shared_award_id,
    award_name: awards.get(event.shared_award_id)?.name || null,
    award_slug: awards.get(event.shared_award_id)?.slug || null,
    source_id: event.shared_award_source_id,
    source_title: event.source_title,
    source_url: event.source_url,
    detected_at: event.detected_at,
    summary: event.summary,
    before: event.change_details?.before || null,
    after: event.change_details?.after || null,
  })),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));

async function loadCandidateEvents() {
  const rows = [];
  for (let from = 0; rows.length < limit; from += batchSize) {
    const to = Math.min(from + batchSize - 1, limit - 1);
    const { data, error } = await withRetry(() =>
      supabase
        .from("shared_award_change_events")
        .select(
          "id,shared_award_id,shared_award_source_id,source_title,source_url,source_page_type,summary,detected_at,change_details",
        )
        .or(
          [
            "summary.ilike.%last retrieved%",
            "summary.ilike.%retrieval date%",
            "summary.ilike.%active committee roster%",
            "summary.ilike.%committee roster%",
            "source_title.ilike.%committee%",
          ].join(","),
        )
        .order("detected_at", { ascending: false })
        .range(from, to),
    );
    if (error) throw new Error(`Load candidate events failed: ${error.message || JSON.stringify(error)}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < batchSize) break;
  }
  return rows;
}

function isRosterRetrievalNoiseEvent(event) {
  const details = event.change_details || {};
  const structured = details.structured_diff || {};
  const text = [
    event.summary,
    event.source_title,
    event.source_url,
    details.section,
    details.before,
    details.after,
    details.reader_summary,
    details.advisor_impact,
    ...(Array.isArray(structured.added_text) ? structured.added_text : []),
    ...(Array.isArray(structured.removed_text) ? structured.removed_text : []),
    ...(Array.isArray(structured.date_changes) ? structured.date_changes : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const hasRosterRetrievalSignal =
    /\b(?:active committee roster as of|displaying active committee roster|committee roster retrieval date|last retrieved on|last retrieved date|retrieval date)\b/.test(
      text,
    ) && /\broster\b/.test(text);

  const hasApplicantSignal =
    /\b(?:application deadline|deadline changed|applications? (?:open|close|due)|eligibility changed|award amount|stipend|tuition|submit by|apply by)\b/.test(
      text,
    );

  return hasRosterRetrievalSignal && !hasApplicantSignal;
}

function sourceLooksQuarantinable(event) {
  const text = [event.source_title, event.source_url, event.source_page_type].filter(Boolean).join(" ").toLowerCase();
  return /\bcommittee\b|\broster\b|\/acrl\/|\/committees?\//.test(text);
}

async function loadRowsById(table, ids, select) {
  const rows = new Map();
  for (const chunk of chunks(ids, 100)) {
    const { data, error } = await withRetry(() => supabase.from(table).select(select).in("id", chunk));
    if (error) throw new Error(`Load ${table} failed: ${error.message || JSON.stringify(error)}`);
    for (const row of data || []) rows.set(row.id, row);
  }
  return rows;
}

async function suppressEventRowsByIds(ids) {
  let count = 0;
  for (const chunk of chunks(unique(ids), 100)) {
    const { data, error } = await withRetry(() =>
      supabase
        .from("shared_award_change_events")
        .update({
          suppressed_at: now,
          suppression_reason: "Roster retrieval/as-of noise suppressed; immutable event evidence was preserved.",
          suppression_source: "awardping-roster-retrieval-noise-cleanup",
        })
        .in("id", chunk)
        .is("suppressed_at", null)
        .select("id"),
    );
    if (error) throw new Error(`Suppress shared_award_change_events failed: ${error.message || JSON.stringify(error)}`);
    count += data?.length || 0;
  }
  return count;
}

async function markSourcesReviewLater(ids) {
  let count = 0;
  for (const chunk of chunks(unique(ids), 100)) {
    const { data, error } = await withRetry(() =>
      supabase
        .from("shared_award_sources")
        .update({
          admin_review_status: "review_later",
          admin_review_note:
            "Auto-quarantined after roster retrieval/as-of date changes were classified as non-applicant-facing update noise.",
          admin_reviewed_at: now,
          admin_reviewed_by: "awardping-roster-retrieval-noise-cleanup",
          updated_at: now,
        })
        .in("id", chunk)
        .select("id"),
    );
    if (error) throw new Error(`Update shared_award_sources failed: ${error.message || JSON.stringify(error)}`);
    count += data?.length || 0;
  }
  return count;
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
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_500));
  }
  return lastResult;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function unique(values) {
  return [...new Set(values)];
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const clean = String(value).toLowerCase();
  if (["1", "true", "yes", "y"].includes(clean)) return true;
  if (["0", "false", "no", "n"].includes(clean)) return false;
  return fallback;
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    parsed[match[1]] = match[2] ?? "true";
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
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
