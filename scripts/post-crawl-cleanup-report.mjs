#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";
import {
  buildPostCrawlCleanupModel,
  cleanupActionLabel,
  cleanupActions,
  csvEscape,
  canonicalSourceUrlKey,
  isUsefulOfficialSource,
} from "./source-cleanup-core.mjs";
import { loadDeterministicSupabaseRows } from "./lib/deterministic-supabase-loader.mjs";
import {
  applyAwardSourceCleanupPlanWithCas,
  buildAwardSourceCleanupPlan,
} from "./lib/source-cleanup-cas.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const env = { ...loadEnvFile(resolve(root, ".env.local")), ...process.env };
const supabaseUrl = String(env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Set NEXT_PUBLIC_SUPABASE_URL and a server-only sb_secret SUPABASE_SERVICE_ROLE_KEY. Automatic Supabase CLI key fallback is disabled.",
  );
}
if (!serviceRoleKey.startsWith("sb_secret_")) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY must be a modern server-only sb_secret key.");
}
const projectRef = projectRefFromSupabaseUrl(supabaseUrl);
const requestedProjectRef = String(args["project-ref"] || "").trim();
if (requestedProjectRef && requestedProjectRef !== projectRef) {
  throw new Error(
    `--project-ref=${requestedProjectRef} does not match the configured Supabase URL project ${projectRef}; refusing to run against an ambiguous target.`,
  );
}
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
  loadAll("awards", "id,shared_award_id,updated_at"),
  loadAll("monitors", "id,shared_award_source_id,updated_at"),
  loadAll("award_sources", "id,shared_award_source_id,updated_at"),
  loadAll(
    "shared_award_source_snapshots",
    "id,shared_award_source_id,source_url,created_at",
    "created_at",
  ),
  loadAll(
    "shared_award_change_events",
    "id,shared_award_id,shared_award_source_id,source_url,detected_at",
    "detected_at",
  ),
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
    const removedSources = safeRows.map((row) => row.source);
    const homepageRepairs = buildRemovedHomepageRepairs(removedSources);
    const cleanupPlans = buildPostCrawlCleanupPlans({
      rows: safeRows,
      homepageRepairs,
    });
    await applyCleanupPlans(cleanupPlans);
    removalResult.deletedRows = 0;
    removalResult.retiredRows = safeRows.length;
    removalResult.homepageRepairs = homepageRepairs.length;
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

async function applyCleanupPlans(plans) {
  for (const plan of plans) {
    await applyAwardSourceCleanupPlanWithCas({
      supabase,
      plan,
      reason: "Retired by post-crawl source cleanup; immutable update and visual history were preserved.",
      actor: "awardping-post-crawl-cleanup",
    });
  }
}

function buildRemovedHomepageRepairs(removedRows) {
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

  const repairs = [];
  for (const award of activeAwards) {
    const removedKeys = removedKeysByAwardId.get(award.id) || [];
    if (!award.official_homepage || !removedKeys.includes(canonicalSourceUrlKey(award.official_homepage))) continue;

    const replacement = (remainingRowsByAwardId.get(award.id) || [])
      .filter((source) => isUsefulOfficialSource(source, award))[0] || null;
    repairs.push({
      award,
      oldUrl: award.official_homepage,
      nextUrl: replacement?.url || null,
      replacementSourceId: replacement?.id || null,
    });
  }
  return repairs;
}

function buildPostCrawlCleanupPlans({ rows, homepageRepairs }) {
  const awardById = new Map(activeAwards.map((award) => [award.id, award]));
  const sourcesByAwardId = groupBy(sources, (source) => source.shared_award_id);
  const rowsByAwardId = groupBy(rows, (row) => row.source.shared_award_id);
  const repairByAwardId = new Map(
    homepageRepairs.map((repair) => [repair.award.id, repair]),
  );
  const plans = [];
  for (const awardId of [...rowsByAwardId.keys()].sort()) {
    const award = awardById.get(awardId);
    if (!award) throw new Error(`Cleanup plan references inactive award ${awardId}.`);
    const awardSources = sourcesByAwardId.get(awardId) || [];
    const awardRows = rowsByAwardId.get(awardId) || [];
    const retiring = awardRows.map((row) => row.source);
    const retiringIds = new Set(retiring.map((source) => source.id));
    const usefulRemainingSourceIds = awardSources
      .filter((source) => source.admin_review_status === "open")
      .filter((source) => !retiringIds.has(source.id))
      .filter((source) => isUsefulOfficialSource(source, award))
      .map((source) => source.id);
    const repair = repairByAwardId.get(awardId) || null;
    for (const row of awardRows) {
      if (row.replacement?.id && !usefulRemainingSourceIds.includes(row.replacement.id)) {
        throw new Error(
          `Cleanup replacement ${row.replacement.id} is no longer useful for award ${awardId}.`,
        );
      }
    }
    plans.push(buildAwardSourceCleanupPlan({
      award,
      allSources: awardSources,
      retireSources: retiring,
      usefulRemainingSourceIds,
      homepageAfter: repair ? repair.nextUrl : award.official_homepage,
      homepageReplacementSourceId: repair?.replacementSourceId || null,
    }));
  }
  return plans;
}

async function loadAll(table, select, revisionColumn = "updated_at") {
  return loadDeterministicSupabaseRows({
    supabase,
    table,
    select,
    revisionColumn,
  });
}

function createSupabaseClient() {
  return createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
}

function projectRefFromSupabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid hosted Supabase URL.");
  }
  const match = parsed.hostname.match(/^([a-z]{20})\.supabase\.co$/i);
  if (!match) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must identify a hosted Supabase project.");
  }
  return match[1].toLowerCase();
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

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function groupBy(values, getKey) {
  const groups = new Map();
  for (const value of values) {
    const key = getKey(value);
    groups.set(key, [...(groups.get(key) || []), value]);
  }
  return groups;
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
