#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";
import {
  buildPostCrawlCleanupModel,
  cleanupActionLabel,
  cleanupActions,
  csvEscape,
  canonicalSourceUrlKey,
} from "./source-cleanup-core.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const projectRef = args["project-ref"] || readLinkedProjectRef();
const apply = args.apply === true || args.apply === "true";
const removeSafe = args["remove-safe"] === true || args["remove-safe"] === "true";
const sampleLimit = positiveInt(args["sample-limit"], 40);
const outputPrefix =
  args["output-prefix"] ||
  join(root, "reports", `post-crawl-cleanup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const markdownPath = `${outputPrefix}.md`;
const jsonPath = `${outputPrefix}.json`;
const reviewCsvPath =
  args["review-output"] ||
  join(root, "reports", `manual-source-review-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);

const supabase = createSupabaseClient();
const [awards, sources, userAwards, monitors, awardSources, snapshots, changes] = await Promise.all([
  loadAll("shared_awards", "id,name,official_homepage,status,updated_at"),
  loadAll(
    "shared_award_sources",
    "id,shared_award_id,url,title,page_type,confidence,source,last_error,last_checked_at,next_check_at,consecutive_failures,admin_review_status,updated_at",
  ),
  loadOptionalAll("awards", "id,shared_award_id"),
  loadOptionalAll("monitors", "id,shared_award_source_id"),
  loadOptionalAll("award_sources", "id,shared_award_source_id"),
  loadOptionalAll("shared_award_source_snapshots", "id,shared_award_source_id,source_url"),
  loadOptionalAll("shared_award_change_events", "id,shared_award_id,shared_award_source_id,source_url"),
]);

const activeAwards = awards.filter((award) => award.status === "active");
const activeAwardIds = new Set(activeAwards.map((award) => award.id));
const activeSources = sources.filter(
  (source) => activeAwardIds.has(source.shared_award_id) && source.admin_review_status !== "review_later",
);
const trackedCountsByAwardId = countBy(userAwards.filter((award) => award.shared_award_id), (award) => award.shared_award_id);
const updateCountsByAwardId = countBy(changes.filter((change) => change.shared_award_id), (change) => change.shared_award_id);

const model = buildPostCrawlCleanupModel({
  awards: activeAwards,
  sources: activeSources,
  trackedCountsByAwardId,
  updateCountsByAwardId,
});

const safeRows = model.sourceRows.filter((row) => row.action === cleanupActions.safeToRemove);
const needsReplacementRows = model.sourceRows.filter((row) => row.action === cleanupActions.needsReplacement);
const keepBlockedRows = model.sourceRows.filter((row) => row.action === cleanupActions.keepButBlocked);
const dependencyCounts = countDependencies(safeRows.map((row) => row.source), {
  monitors,
  awardSources,
  snapshots,
  changes,
});

let removalResult = null;
if (removeSafe) {
  removalResult = {
    apply,
    rowsRequested: safeRows.length,
    dependencies: dependencyCounts,
  };
  if (apply && safeRows.length) {
    await cleanupSources(safeRows.map((row) => row.source));
    const homepageResult = await repairRemovedHomepages(safeRows.map((row) => row.source));
    removalResult.deletedRows = 0;
    removalResult.retiredRows = safeRows.length;
    removalResult.homepageRepairs = homepageResult;
  }
}

mkdirSync(dirname(markdownPath), { recursive: true });
mkdirSync(dirname(reviewCsvPath), { recursive: true });

writeFileSync(markdownPath, renderMarkdownReport(), "utf8");
writeFileSync(jsonPath, JSON.stringify(renderJsonReport(), null, 2), "utf8");
writeFileSync(reviewCsvPath, renderManualReviewCsv(), "utf8");

console.log(
  JSON.stringify(
    {
      markdownPath,
      jsonPath,
      reviewCsvPath,
      activeAwards: activeAwards.length,
      activeSources: activeSources.length,
      actionCounts: model.actionCounts,
      failureBuckets: model.failureBuckets,
      lowCoverageAwards: model.lowCoverageAwards.length,
      safeToRemove: safeRows.length,
      needsReplacement: needsReplacementRows.length,
      keepButBlocked: keepBlockedRows.length,
      removeSafe,
      apply,
    },
    null,
    2,
  ),
);

function renderMarkdownReport() {
  const lines = [
    "# Post-Crawl Source Cleanup Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    `- Active awards: ${activeAwards.length}`,
    `- Active source rows: ${activeSources.length}`,
    `- Safe to remove: ${safeRows.length}`,
    `- Needs replacement: ${needsReplacementRows.length}`,
    `- Keep but blocked: ${keepBlockedRows.length}`,
    `- Low coverage awards (0-1 useful official pages): ${model.lowCoverageAwards.length}`,
    `- Manual review CSV: ${reviewCsvPath}`,
    "",
    "## Failure Buckets",
    "",
    ...renderCounts(model.failureBuckets),
    "",
    "## Action Buckets",
    "",
    ...renderCounts(model.actionCounts),
    "",
    "## Safe To Remove",
    "",
  ];

  appendActionRows(lines, safeRows);
  lines.push("## Needs Replacement", "");
  appendActionRows(lines, needsReplacementRows);
  lines.push("## Keep But Blocked", "");
  appendActionRows(lines, keepBlockedRows);
  lines.push("## Low Coverage Awards", "");
  appendLowCoverageRows(lines, model.lowCoverageAwards);

  if (removeSafe) {
    lines.push("## Removal Mode", "");
    lines.push(`- Apply: ${apply ? "yes" : "no"}`);
    lines.push(`- Rows requested: ${safeRows.length}`);
    lines.push(`- Dependent monitors: ${dependencyCounts.monitors}`);
    lines.push(`- Dependent award sources: ${dependencyCounts.awardSources}`);
    lines.push(`- Dependent snapshots by id/url: ${dependencyCounts.snapshotsById}/${dependencyCounts.snapshotsByUrl}`);
    lines.push(`- Dependent change events by id/url: ${dependencyCounts.changesById}/${dependencyCounts.changesByUrl}`);
    if (!apply) lines.push("- Dry run only. Re-run with `-- --apply=true` to retire safe rows while preserving history.");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function renderJsonReport() {
  return {
    generatedAt: new Date().toISOString(),
    options: {
      apply,
      removeSafe,
      sampleLimit,
      projectRef: projectRef || null,
    },
    counts: {
      activeAwards: activeAwards.length,
      activeSources: activeSources.length,
      actionCounts: model.actionCounts,
      failureBuckets: model.failureBuckets,
      safeToRemove: safeRows.length,
      needsReplacement: needsReplacementRows.length,
      keepButBlocked: keepBlockedRows.length,
      lowCoverageAwards: model.lowCoverageAwards.length,
    },
    dependencyCounts,
    removalResult,
    safeToRemove: safeRows.map(serializeActionRow),
    needsReplacement: needsReplacementRows.map(serializeActionRow),
    keepButBlocked: keepBlockedRows.map(serializeActionRow),
    lowCoverageAwards: model.lowCoverageAwards,
  };
}

function renderManualReviewCsv() {
  const headers = [
    "action",
    "reason",
    "award_name",
    "current_title",
    "current_url",
    "last_error",
    "last_checked_at",
    "suggested_replacement_title",
    "suggested_replacement_url",
    "notes",
  ];

  const rows = [...needsReplacementRows, ...keepBlockedRows].map((row) => [
    row.action,
    row.reason,
    row.award?.name || "",
    row.source.title || "",
    row.source.url || "",
    row.source.last_error || "",
    row.source.last_checked_at || "",
    row.replacement?.title || "",
    row.replacement?.url || "",
    row.action === cleanupActions.keepButBlocked
      ? "Keep unless a reviewed official replacement is added."
      : "Find a current official organization page before removing if this is the only useful source.",
  ]);

  return `${[headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function appendActionRows(lines, rows) {
  if (!rows.length) {
    lines.push("None.", "");
    return;
  }

  for (const row of rows.slice(0, sampleLimit)) {
    lines.push(`- ${row.award?.name || "Unknown award"}`);
    lines.push(`  - Action: ${cleanupActionLabel(row.action)}`);
    lines.push(`  - Reason: ${row.reason}`);
    lines.push(`  - Source: ${row.source.title || "Untitled"} - ${row.source.url}`);
    if (row.source.last_error) lines.push(`  - Last error: ${row.source.last_error}`);
    if (row.replacement) lines.push(`  - Candidate replacement: ${row.replacement.title || "Untitled"} - ${row.replacement.url}`);
  }
  if (rows.length > sampleLimit) lines.push(`- ...${rows.length - sampleLimit} more`);
  lines.push("");
}

function appendLowCoverageRows(lines, rows) {
  if (!rows.length) {
    lines.push("None.", "");
    return;
  }

  for (const award of rows.slice(0, sampleLimit)) {
    lines.push(
      `- ${award.awardName} (${award.usefulSourceCount} useful / ${award.sourceCount} total, tracked ${award.trackedCount}, updates ${award.updateCount})`,
    );
    if (award.usefulSources[0]) lines.push(`  - Current useful source: ${award.usefulSources[0].url}`);
  }
  if (rows.length > sampleLimit) lines.push(`- ...${rows.length - sampleLimit} more`);
  lines.push("");
}

function renderCounts(counts) {
  const entries = Object.entries(counts || {}).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return ["None."];
  return entries.map(([key, count]) => `- ${key}: ${count}`);
}

function serializeActionRow(row) {
  return {
    action: row.action,
    reason: row.reason,
    failureBucket: row.failureBucket,
    awardId: row.award?.id || row.source.shared_award_id,
    awardName: row.award?.name || null,
    sourceId: row.source.id,
    title: row.source.title,
    url: row.source.url,
    pageType: row.source.page_type,
    lastError: row.source.last_error,
    lastCheckedAt: row.source.last_checked_at,
    replacement: row.replacement
      ? {
          id: row.replacement.id,
          title: row.replacement.title,
          url: row.replacement.url,
          pageType: row.replacement.page_type,
        }
      : null,
  };
}

function countDependencies(sourceRows, tables) {
  const ids = new Set(sourceRows.map((row) => row.id).filter(Boolean));
  const urls = new Set(sourceRows.map((row) => canonicalSourceUrlKey(row.url)).filter(Boolean));

  return {
    monitors: tables.monitors.filter((row) => ids.has(row.shared_award_source_id)).length,
    awardSources: tables.awardSources.filter((row) => ids.has(row.shared_award_source_id)).length,
    snapshotsById: tables.snapshots.filter((row) => ids.has(row.shared_award_source_id)).length,
    snapshotsByUrl: tables.snapshots.filter((row) => urls.has(canonicalSourceUrlKey(row.source_url))).length,
    changesById: tables.changes.filter((row) => ids.has(row.shared_award_source_id)).length,
    changesByUrl: tables.changes.filter((row) => urls.has(canonicalSourceUrlKey(row.source_url))).length,
  };
}

async function cleanupSources(rows) {
  for (const sourceId of [...new Set(rows.map((row) => row.id).filter(Boolean))]) {
    const { data, error } = await supabase.rpc("retire_shared_award_source_preserving_visual_history", {
      p_source_id: sourceId,
      p_reason: "Retired by post-crawl source cleanup; immutable update and visual history were preserved.",
      p_actor: "awardping-post-crawl-cleanup",
    });
    const result = Array.isArray(data) ? data[0] : data;
    if (error || !result?.source_id) {
      throw new Error(`Retire shared source ${sourceId}: ${error?.message || "no durable result"}`);
    }
  }
}

async function repairRemovedHomepages(removedRows) {
  const removedKeysByAwardId = new Map();
  for (const row of removedRows) {
    removedKeysByAwardId.set(row.shared_award_id, [
      ...(removedKeysByAwardId.get(row.shared_award_id) || []),
      canonicalSourceUrlKey(row.url),
    ]);
  }

  const remainingRowsByAwardId = new Map();
  const removedIds = new Set(removedRows.map((row) => row.id));
  for (const row of activeSources) {
    if (removedIds.has(row.id)) continue;
    remainingRowsByAwardId.set(row.shared_award_id, [...(remainingRowsByAwardId.get(row.shared_award_id) || []), row]);
  }

  let repaired = 0;
  for (const award of activeAwards) {
    const removedKeys = removedKeysByAwardId.get(award.id) || [];
    if (!award.official_homepage || !removedKeys.includes(canonicalSourceUrlKey(award.official_homepage))) continue;

    const replacement = (remainingRowsByAwardId.get(award.id) || [])[0] || null;
    const { error } = await supabase
      .from("shared_awards")
      .update({ official_homepage: replacement?.url || null, updated_at: new Date().toISOString() })
      .eq("id", award.id);
    if (error) throw new Error(`shared_awards ${award.id}: ${error.message}`);
    repaired += 1;
  }

  return repaired;
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

function countBy(values, getKey) {
  const counts = new Map();
  for (const value of values) {
    const key = getKey(value);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
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

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [rawKey, inlineValue] = value.slice(2).split("=");
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[rawKey] = next;
      index += 1;
    } else {
      parsed[rawKey] = true;
    }
  }
  return parsed;
}
