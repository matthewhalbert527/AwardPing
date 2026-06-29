#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPostCrawlCleanupModel,
  cleanupActions,
} from "./source-cleanup-core.mjs";
import {
  classifySourceForConsolidation,
  sourceQualityScore,
} from "./source-consolidation-core.mjs";
import { classifySourceHygiene } from "./source-hygiene.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const apply = boolArg(args.apply, false);
const sourceLimit = positiveInt(args.limit, 60_000);
const maxSourcesPerAward = positiveInt(args["max-sources-per-award"], 25);
const minSourcesPerAward = positiveInt(args["min-sources-per-award"], 5);
const lowQualityThreshold = numberArg(args["low-quality-threshold"], 45);
const maxApply = positiveInt(args["max-apply"], 10_000);
const batchSize = positiveInt(args["batch-size"], 250);
const reportDir = resolve(String(args["report-dir"] || "reports"));
const excludeReasons = csvSet(args["exclude-reasons"]);
const onlyReasons = csvSet(args["only-reasons"]);

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const supabase = createSupabaseServiceClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
);

const awards = await loadAll(
  "shared_awards",
  "id,name,official_homepage,status,source,updated_at",
  (query) => query.eq("status", "active"),
);
const sources = await loadAll(
  "shared_award_sources",
  [
    "id",
    "shared_award_id",
    "url",
    "title",
    "display_title",
    "page_description",
    "page_type",
    "confidence",
    "reason",
    "source",
    "last_error",
    "last_checked_at",
    "consecutive_failures",
    "admin_review_status",
    "created_at",
    "updated_at",
  ].join(","),
  (query) => query.eq("admin_review_status", "open").limit(sourceLimit),
);

const awardsById = new Map(awards.map((award) => [award.id, award]));
const sourcesByAwardId = groupBy(sources, (source) => source.shared_award_id);
const cleanupModel = buildPostCrawlCleanupModel({ awards, sources });
const candidateById = new Map();

for (const row of cleanupModel.sourceRows) {
  if (row.action !== cleanupActions.safeToRemove) continue;
  addCandidate(candidateById, row.source, row.award, {
    reason: `cleanup_${row.reason}`,
    note: row.replacement
      ? `Existing cleanup model found a better source: ${row.replacement.title || row.replacement.url}`
      : "Existing cleanup model classified this source as safe to remove.",
    qualityScore: sourceQualityScore(row.source, row.award || {}).score,
    priority: 90,
  });
}

for (const source of sources) {
  const award = awardsById.get(source.shared_award_id) || null;
  const hygiene = classifySourceHygiene({
    ...source,
    award_name: award?.name || "",
  });
  if (hygiene.action === "review_later") {
    addCandidate(candidateById, source, award, {
      reason: `hygiene_${hygiene.reason}`,
      note: hygiene.note || "Source hygiene classifier rejected this source.",
      qualityScore: sourceQualityScore(source, award || {}).score,
      priority: 85,
    });
    continue;
  }

  const consolidation = classifySourceForConsolidation(source, award || {});
  if (consolidation.action === "review_later") {
    addCandidate(candidateById, source, award, {
      reason: consolidation.reason,
      note: consolidation.note,
      qualityScore: consolidation.qualityScore,
      signals: consolidation.signals,
      priority: 70,
    });
  }
}

for (const [awardId, awardSources] of sourcesByAwardId.entries()) {
  if (awardSources.length <= maxSourcesPerAward) continue;
  const award = awardsById.get(awardId) || null;
  const ranked = [...awardSources]
    .map((source) => ({
      source,
      quality: sourceQualityScore(source, award || {}),
    }))
    .sort(
      (left, right) =>
        right.quality.score - left.quality.score ||
        String(left.source.title || left.source.url).localeCompare(String(right.source.title || right.source.url)),
    );

  for (const item of ranked.slice(maxSourcesPerAward)) {
    const consolidation = classifySourceForConsolidation(item.source, award || {}, {
      excess: true,
      lowQualityThreshold,
    });
    if (consolidation.action !== "review_later") continue;
    addCandidate(candidateById, item.source, award, {
      reason: consolidation.reason,
      note: consolidation.note,
      qualityScore: consolidation.qualityScore,
      signals: consolidation.signals,
      priority: 35,
    });
  }
}

const filteredCandidates = [...candidateById.values()].filter((candidate) =>
  reasonAllowed(candidate.reason),
);
const selected = selectSafeCandidates({
  candidates: filteredCandidates,
  sourcesByAwardId,
  minSourcesPerAward,
  maxApply,
});

const summary = summarize(selected, sources, awards);
const report = {
  generated_at: new Date().toISOString(),
  apply,
  source_limit: sourceLimit,
  max_sources_per_award: maxSourcesPerAward,
  min_sources_per_award: minSourcesPerAward,
  low_quality_threshold: lowQualityThreshold,
  max_apply: maxApply,
  excluded_reasons: [...excludeReasons],
  only_reasons: [...onlyReasons],
  loaded_awards: awards.length,
  loaded_open_sources: sources.length,
  candidates_found: candidateById.size,
  candidates_after_reason_filter: filteredCandidates.length,
  candidates_selected: selected.length,
  ...summary,
  selected: selected.map(reportCandidate),
};

mkdirSync(reportDir, { recursive: true });
const reportPath = resolve(
  reportDir,
  `source-consolidation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      ...report,
      selected: undefined,
      report_path: reportPath,
      sample: report.selected.slice(0, 25),
    },
    null,
    2,
  ),
);

if (apply && selected.length) {
  const now = new Date().toISOString();
  let updated = 0;
  for (let index = 0; index < selected.length; index += batchSize) {
    const batch = selected.slice(index, index + batchSize);
    const ids = batch.map((candidate) => candidate.source.id);
    const { error } = await supabase
      .from("shared_award_sources")
      .update({
        admin_review_status: "review_later",
        admin_review_note: "Auto-consolidated: duplicate, broad, or low-signal source page. Kept out of daily screenshots unless restored.",
        admin_reviewed_at: now,
        admin_reviewed_by: "awardping-source-consolidation",
        updated_at: now,
      })
      .in("id", ids);
    if (error) throw new Error(`shared_award_sources consolidation update failed: ${error.message}`);
    updated += batch.length;
    console.log(`CONSOLIDATED review_later ${updated}/${selected.length}`);
  }
}

const remaining = apply ? await countActiveOpenSources() : null;
console.log(
  JSON.stringify(
    {
      apply,
      updated_review_later: apply ? selected.length : 0,
      active_open_sources_remaining: remaining,
      report_path: reportPath,
    },
    null,
    2,
  ),
);

function addCandidate(map, source, award, details) {
  if (!source?.id) return;
  const existing = map.get(source.id);
  const candidate = {
    source,
    award,
    reason: details.reason,
    note: details.note || null,
    qualityScore: Number(details.qualityScore || 0),
    signals: details.signals || [],
    priority: Number(details.priority || 0),
  };
  if (
    !existing ||
    candidate.priority > existing.priority ||
    (candidate.priority === existing.priority && candidate.qualityScore < existing.qualityScore)
  ) {
    map.set(source.id, candidate);
  }
}

function selectSafeCandidates({ candidates, sourcesByAwardId, minSourcesPerAward, maxApply }) {
  const remainingByAward = new Map(
    [...sourcesByAwardId.entries()].map(([awardId, values]) => [awardId, values.length]),
  );
  const selected = [];
  const sorted = [...candidates].sort(
    (left, right) =>
      right.priority - left.priority ||
      left.qualityScore - right.qualityScore ||
      String(left.award?.name || "").localeCompare(String(right.award?.name || "")),
  );

  for (const candidate of sorted) {
    const awardId = candidate.source.shared_award_id;
    const remaining = remainingByAward.get(awardId) || 0;
    if (remaining <= minSourcesPerAward) continue;
    selected.push(candidate);
    remainingByAward.set(awardId, remaining - 1);
    if (selected.length >= maxApply) break;
  }
  return selected;
}

function summarize(selected, sources, awards) {
  const reasonCounts = countBy(selected, (candidate) => candidate.reason);
  const awardCounts = countBy(selected, (candidate) => candidate.award?.name || candidate.source.shared_award_id);
  const topAwards = Object.entries(awardCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 30)
    .map(([award, count]) => ({ award, count }));
  return {
    reason_counts: reasonCounts,
    selected_award_count: Object.keys(awardCounts).length,
    top_awards: topAwards,
    untouched_awards: awards.length - Object.keys(awardCounts).length,
    open_sources_before: sources.length,
    projected_open_sources_after: sources.length - selected.length,
  };
}

function reportCandidate(candidate) {
  return {
    award: candidate.award?.name || candidate.source.shared_award_id,
    title: candidate.source.title,
    page_type: candidate.source.page_type,
    reason: candidate.reason,
    quality_score: candidate.qualityScore,
    signals: candidate.signals,
    url: candidate.source.url,
  };
}

function reasonAllowed(reason) {
  const value = String(reason || "");
  if (excludeReasons.has(value)) return false;
  if (onlyReasons.size && !onlyReasons.has(value)) return false;
  return true;
}

async function loadAll(table, select, applyQuery = null) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = supabase
      .from(table)
      .select(select)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (applyQuery) query = applyQuery(query);
    const { data, error } = await query;
    if (error) throw new Error(`${table} load failed: ${error.message}`);
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function countActiveOpenSources() {
  const { count, error } = await supabase
    .from("shared_award_sources")
    .select("id,shared_awards!inner(id,status)", { count: "exact", head: true })
    .eq("admin_review_status", "open")
    .eq("shared_awards.status", "active");
  if (error) throw new Error(`count shared_award_sources failed: ${error.message}`);
  return count || 0;
}

function groupBy(values, getKey) {
  const groups = new Map();
  for (const value of values) {
    const key = getKey(value);
    groups.set(key, [...(groups.get(key) || []), value]);
  }
  return groups;
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
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const raw = value.slice(2);
    if (raw.includes("=")) {
      const [key, ...rest] = raw.split("=");
      parsed[key] = rest.join("=");
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[raw] = next;
      index += 1;
    } else {
      parsed[raw] = true;
    }
  }
  return parsed;
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (/^(1|true|yes|y)$/i.test(String(value))) return true;
  if (/^(0|false|no|n)$/i.test(String(value))) return false;
  return fallback;
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function numberArg(value, fallback) {
  const number = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? number : fallback;
}

function csvSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function loadEnvFile(path) {
  const values = {};
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[match[1]] = value;
    }
  } catch {
    // Optional env file.
  }
  return values;
}
