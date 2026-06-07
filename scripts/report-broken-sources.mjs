#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";
import { csvEscape, sourceFailureBucket } from "./source-cleanup-core.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const projectRef = args["project-ref"] || readLinkedProjectRef();
const outputPrefix =
  args["output-prefix"] ||
  join(root, "reports", `broken-source-review-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const csvPath = `${outputPrefix}.csv`;
const markdownPath = `${outputPrefix}.md`;
const jsonPath = `${outputPrefix}.json`;

const supabase = createSupabaseClient();
const [awards, sharedSources, monitors, officeAwards] = await Promise.all([
  loadAll("shared_awards", "id,name,status"),
  loadAll(
    "shared_award_sources",
    "id,shared_award_id,title,url,page_type,last_error,last_checked_at,next_check_at,consecutive_failures",
  ),
  loadOptionalAll(
    "monitors",
    "id,award_id,label,url,status,last_error,last_checked_at,next_check_at,consecutive_failures",
  ),
  loadOptionalAll("awards", "id,name,status"),
]);

const activeAwardById = new Map(
  awards.filter((award) => award.status === "active").map((award) => [award.id, award]),
);
const officeAwardById = new Map(officeAwards.map((award) => [award.id, award]));

const brokenSharedSources = sharedSources
  .filter((source) => activeAwardById.has(source.shared_award_id))
  .filter((source) => Boolean(String(source.last_error || "").trim()))
  .map((source) => {
    const bucket = sourceFailureBucket(source.last_error);
    return {
      scope: "shared_award_source",
      awardName: activeAwardById.get(source.shared_award_id)?.name || "",
      sourceTitle: source.title || "",
      url: source.url || "",
      pageType: source.page_type || "",
      status: "",
      failureBucket: bucket,
      httpStatus: httpStatusFromError(source.last_error),
      lastError: source.last_error || "",
      lastCheckedAt: source.last_checked_at || "",
      nextCheckAt: source.next_check_at || "",
      consecutiveFailures: source.consecutive_failures || 0,
      suggestedAction: suggestedAction(bucket),
    };
  });

const brokenMonitors = monitors
  .filter((monitor) => Boolean(String(monitor.last_error || "").trim()))
  .map((monitor) => {
    const bucket = sourceFailureBucket(monitor.last_error);
    return {
      scope: "office_monitor",
      awardName: officeAwardById.get(monitor.award_id)?.name || "",
      sourceTitle: monitor.label || "",
      url: monitor.url || "",
      pageType: "",
      status: monitor.status || "",
      failureBucket: bucket,
      httpStatus: httpStatusFromError(monitor.last_error),
      lastError: monitor.last_error || "",
      lastCheckedAt: monitor.last_checked_at || "",
      nextCheckAt: monitor.next_check_at || "",
      consecutiveFailures: monitor.consecutive_failures || 0,
      suggestedAction: suggestedAction(bucket),
    };
  });

const rows = [...brokenSharedSources, ...brokenMonitors].sort((left, right) =>
  [left.failureBucket, left.awardName, left.sourceTitle, left.url]
    .join("\t")
    .localeCompare([right.failureBucket, right.awardName, right.sourceTitle, right.url].join("\t")),
);
const counts = countBy(rows, (row) => row.failureBucket || "unknown");

mkdirSync(dirname(csvPath), { recursive: true });
writeFileSync(csvPath, renderCsv(rows), "utf8");
writeFileSync(markdownPath, renderMarkdown(rows, counts), "utf8");
writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), counts, rows }, null, 2), "utf8");

console.log(
  JSON.stringify(
    {
      csvPath,
      markdownPath,
      jsonPath,
      brokenSources: rows.length,
      failureBuckets: counts,
    },
    null,
    2,
  ),
);

function renderCsv(values) {
  const headers = [
    "scope",
    "award_name",
    "source_title",
    "url",
    "page_type",
    "status",
    "failure_bucket",
    "http_status",
    "last_error",
    "last_checked_at",
    "next_check_at",
    "consecutive_failures",
    "suggested_action",
  ];
  const table = values.map((row) => [
    row.scope,
    row.awardName,
    row.sourceTitle,
    row.url,
    row.pageType,
    row.status,
    row.failureBucket,
    row.httpStatus || "",
    row.lastError,
    row.lastCheckedAt,
    row.nextCheckAt,
    String(row.consecutiveFailures),
    row.suggestedAction,
  ]);

  return `${[headers, ...table].map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function renderMarkdown(values, bucketCounts) {
  const lines = [
    "# Broken Source Review",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "This report lists source URLs that still have crawler errors recorded. These should stay out of general audience UI and be reviewed by the AwardPing operator.",
    "",
    "## Summary",
    "",
    `- Broken shared sources: ${brokenSharedSources.length}`,
    `- Broken office monitors: ${brokenMonitors.length}`,
    `- CSV: ${csvPath}`,
    `- JSON: ${jsonPath}`,
    "",
    "## Failure Buckets",
    "",
    ...Object.entries(bucketCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucket, count]) => `- ${bucket}: ${count}`),
    "",
    "## Review Sample",
    "",
  ];

  for (const row of values.slice(0, 80)) {
    lines.push(`- ${row.awardName || row.sourceTitle || row.url}`);
    lines.push(`  - Scope: ${row.scope}`);
    lines.push(`  - Reason: ${row.failureBucket}`);
    lines.push(`  - URL: ${row.url}`);
    lines.push(`  - Last error: ${row.lastError}`);
    lines.push(`  - Suggested action: ${row.suggestedAction}`);
  }
  if (values.length > 80) lines.push(`- ...${values.length - 80} more in the CSV`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function suggestedAction(bucket) {
  if (bucket === "429_rate_limited") {
    return "Leave queued for a slower later retry. If it repeats, reduce domain frequency or ask the site for an allowlist/feed.";
  }
  if (bucket === "403_blocked" || bucket === "405_method_blocked") {
    return "Keep if official, but look for an alternate official page/PDF/feed or request allowlisting. Use browser/manual review if no alternate exists.";
  }
  if (bucket === "404_gone" || bucket === "410_gone" || bucket === "dead_dns") {
    return "Find a current official replacement URL before removing if this is the only useful source.";
  }
  if (bucket === "no_readable_text") {
    return "Open in a browser and replace with a more direct official HTML/PDF page if available.";
  }
  if (bucket === "timeout" || bucket === "fetch_failed") {
    return "Retry after crawler header/throttle changes; if repeated, review manually and find a replacement or browser-check path.";
  }
  return "Review manually and decide whether to replace, keep as official-but-not-crawlable, or remove.";
}

function httpStatusFromError(value) {
  const match = String(value || "").match(/\b(?:HTTP|status)\s*:?[\s-]*(\d{3})\b/i);
  return match ? match[1] : "";
}

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function loadOptionalAll(table, select) {
  try {
    return await loadAll(table, select);
  } catch (error) {
    console.warn(`Skipping optional table ${table}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function createSupabaseClient() {
  const env = { ...loadEnvFile(resolve(root, ".env.local")), ...process.env };
  if (
    env.NEXT_PUBLIC_SUPABASE_URL &&
    env.SUPABASE_SERVICE_ROLE_KEY &&
    !env.NEXT_PUBLIC_SUPABASE_URL.includes("127.0.0.1")
  ) {
    return createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  if (!projectRef) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or link Supabase.");
  }

  const keys = JSON.parse(
    execFileSync("npx", ["supabase", "projects", "api-keys", "--project-ref", projectRef, "--output", "json"], {
      encoding: "utf8",
      cwd: root,
    }),
  );
  const serviceRoleKey = keys.find((key) => key.name === "service_role")?.api_key;
  if (!serviceRoleKey) throw new Error(`Could not read service_role key for ${projectRef}.`);
  return createSupabaseServiceClient(`https://${projectRef}.supabase.co`, serviceRoleKey);
}

function loadEnvFile(path) {
  try {
    const env = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
    }
    return env;
  } catch {
    return {};
  }
}

function readLinkedProjectRef() {
  try {
    return readFileSync(resolve(root, "supabase/.temp/project-ref"), "utf8").trim();
  } catch {
    return "";
  }
}

function countBy(values, getKey) {
  const counts = {};
  for (const value of values) {
    const key = getKey(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    const match = value.match(/^--([^=]+)=(.*)$/);
    if (match) parsed[match[1]] = match[2];
  }
  return parsed;
}
