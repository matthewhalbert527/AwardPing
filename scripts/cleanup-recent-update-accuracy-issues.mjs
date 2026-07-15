#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const env = {
  ...loadEnvFile(resolve(root, ".env.local")),
  ...process.env,
};
const auditPath = resolve(root, args.audit || "reports/recent-update-accuracy-audit.json");
const outputPath = resolve(
  root,
  args.output || "reports/recent-update-accuracy-cleanup-result.json",
);
const apply = boolArg(args.apply, false);

if (!existsSync(auditPath)) {
  throw new Error(`Audit file does not exist: ${auditPath}`);
}

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const audit = JSON.parse(readFileSync(auditPath, "utf8"));
const issues = Array.isArray(audit.issues) ? audit.issues : [];
const issueIds = unique(issues.map((event) => event.id).filter(Boolean));
const sourcesToReviewLater = unique(
  issues
    .filter(shouldMoveSourceToReviewLater)
    .map((event) => event.source_id)
    .filter(Boolean),
);
const now = new Date().toISOString();

const result = {
  audit_path: auditPath,
  output_path: outputPath,
  apply,
  issue_events_from_audit: issueIds.length,
  source_rows_to_review_later: sourcesToReviewLater.length,
  deleted_events: 0,
  suppressed_events: 0,
  marked_sources_review_later: 0,
  still_live_issue_events: null,
  still_unsuppressed_issue_events: null,
  still_open_review_later_sources: null,
};

if (apply) {
  result.suppressed_events = await suppressEvents(issueIds, now);
  result.marked_sources_review_later = await markSourcesReviewLater(sourcesToReviewLater, now);
  result.still_live_issue_events = await countRowsByIds("shared_award_change_events", issueIds);
  result.still_unsuppressed_issue_events = await countUnsuppressedEvents(issueIds);
  result.still_open_review_later_sources = await countOpenSourcesByIds(sourcesToReviewLater);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify(result, null, 2));

function shouldMoveSourceToReviewLater(event) {
  const category = primaryIssueCategory(event);
  const url = String(event.source_url || "").toLowerCase();

  if (
    [
      "wrong or generic source",
      "calendar/event noise",
      "stale archive source",
      "fundraising/promo noise",
      "operating-hours/access noise",
    ].includes(category)
  ) {
    return true;
  }

  if (category === "site chrome / transient page noise") {
    return isKnownNonAwardChromeSource(url);
  }

  return false;
}

function primaryIssueCategory(event) {
  const issues = Array.isArray(event.issues) ? event.issues : [];
  return (
    issues.find((issue) => issue?.severity === "high")?.category ||
    issues.find((issue) => issue?.severity === "medium")?.category ||
    issues[0]?.category ||
    ""
  );
}

function isKnownNonAwardChromeSource(url) {
  return (
    /gsa\.gov\/reference\/(?:civil-rights-programs|freedom-of-information-act-foia)\//.test(url) ||
    /lib\.ncsu\.edu\/hours\//.test(url) ||
    /addison\.andover\.edu\/?$/.test(url) ||
    /owhl\.andover\.edu\/?$/.test(url) ||
    /cjh\.org\/(?:genealogy\/search|visit\/closures)/.test(url)
  );
}

async function suppressEvents(ids, suppressedAt) {
  let suppressed = 0;
  for (const chunk of chunks(ids, 100)) {
    const { data, error } = await supabase
      .from("shared_award_change_events")
      .update({
        suppressed_at: suppressedAt,
        suppression_reason: "Suppressed by recent update accuracy cleanup; immutable event evidence was preserved.",
        suppression_source: "awardping-recent-update-accuracy-cleanup",
      })
      .in("id", chunk)
      .is("suppressed_at", null)
      .select("id");
    if (error) throw new Error(`Suppress shared_award_change_events failed: ${error.message}`);
    suppressed += data?.length || 0;
  }
  return suppressed;
}

async function countUnsuppressedEvents(ids) {
  let count = 0;
  for (const chunk of chunks(ids, 100)) {
    const { count: chunkCount, error } = await supabase
      .from("shared_award_change_events")
      .select("id", { count: "exact", head: true })
      .in("id", chunk)
      .is("suppressed_at", null);
    if (error) throw new Error(`Count unsuppressed change events failed: ${error.message}`);
    count += chunkCount || 0;
  }
  return count;
}

async function markSourcesReviewLater(ids, reviewedAt) {
  let marked = 0;
  for (const chunk of chunks(ids, 100)) {
    const { data, error } = await supabase
      .from("shared_award_sources")
      .update({
        admin_review_status: "review_later",
        admin_review_note:
          "Moved out of active monitoring after recent update accuracy audit found non-award or noisy source behavior.",
        admin_reviewed_at: reviewedAt,
        admin_reviewed_by: "awardping-recent-update-accuracy-cleanup",
        updated_at: reviewedAt,
      })
      .in("id", chunk)
      .select("id");
    if (error) throw new Error(`Update shared_award_sources failed: ${error.message}`);
    marked += data?.length || 0;
  }
  return marked;
}

async function countRowsByIds(table, ids) {
  let count = 0;
  for (const chunk of chunks(ids, 100)) {
    const { count: chunkCount, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .in("id", chunk);
    if (error) throw new Error(`Count ${table} failed: ${error.message}`);
    count += chunkCount || 0;
  }
  return count;
}

async function countOpenSourcesByIds(ids) {
  let count = 0;
  for (const chunk of chunks(ids, 100)) {
    const { count: chunkCount, error } = await supabase
      .from("shared_award_sources")
      .select("id", { count: "exact", head: true })
      .in("id", chunk)
      .eq("admin_review_status", "open");
    if (error) throw new Error(`Count open shared_award_sources failed: ${error.message}`);
    count += chunkCount || 0;
  }
  return count;
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

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    parsed[match[1]] = match[2] ?? "true";
  }
  return parsed;
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const clean = String(value).toLowerCase();
  if (["1", "true", "yes", "y"].includes(clean)) return true;
  if (["0", "false", "no", "n"].includes(clean)) return false;
  return fallback;
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
