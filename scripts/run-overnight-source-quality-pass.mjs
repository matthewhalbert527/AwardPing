#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { awardMonitoringPolicy } from "./lib/award-monitoring-policy.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));

if (boolArg(args.help, false)) {
  printHelp();
  process.exit(0);
}

const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const apply = boolArg(args.apply, false);
const hours = positiveNumber(args.hours, 10);
const maxAwards = positiveInt(args["max-awards"], 40);
const minOpenSources = positiveInt(args["min-open-sources"], 75);
const sourcePageSize = positiveInt(args["source-page-size"], 500);
const minSourcePageSize = positiveInt(args["min-source-page-size"], 10);
const batchSize = positiveInt(args["batch-size"], 200);
const safety = cleanChoice(args.safety, ["safe", "full"], "full");
const cleanupTitles = boolArg(args["cleanup-titles"], true);
const aggregateFacts = boolArg(args["aggregate-facts"], true);
const forceAggregateFacts = boolArg(args["force-aggregate-facts"], true);
const stopOnFailure = boolArg(args["stop-on-failure"], false);
const explicitSlugs = csvList(args["award-slugs"]);
const startedAt = new Date();
const deadlineMs = startedAt.getTime() + hours * 60 * 60 * 1000;
const runStamp = timestampForPath(startedAt.toISOString());
const reportDir = join(root, "reports", `overnight-source-quality-${runStamp}`);
const reportPath = join(reportDir, "summary.json");
const supabase = createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

mkdirSync(reportDir, { recursive: true });

const report = {
  started_at: startedAt.toISOString(),
  finished_at: null,
  status: "running",
  apply,
  options: {
    hours,
    max_awards: maxAwards,
    min_open_sources: minOpenSources,
    source_page_size: sourcePageSize,
    min_source_page_size: minSourcePageSize,
    batch_size: batchSize,
    safety,
    cleanup_titles: cleanupTitles,
    aggregate_facts: aggregateFacts,
    force_aggregate_facts: forceAggregateFacts,
    explicit_slugs: explicitSlugs,
  },
  monitoring_policy: {
    name: awardMonitoringPolicy.name || "AwardPing global monitoring policy",
    version: awardMonitoringPolicy.version || null,
    updated_at: awardMonitoringPolicy.updated_at || null,
    source_quality_stipulations: Array.isArray(awardMonitoringPolicy.source_quality_stipulations)
      ? awardMonitoringPolicy.source_quality_stipulations.length
      : 0,
    policy_flags: Array.isArray(awardMonitoringPolicy.policy_flags)
      ? awardMonitoringPolicy.policy_flags.length
      : 0,
  },
  selected_awards: [],
  completed_awards: [],
  failed_awards: [],
  commands: [],
};

try {
  console.log(
    [
      "OVERNIGHT_SOURCE_QUALITY_PASS",
      `apply=${apply}`,
      `hours=${hours}`,
      `safety=${safety}`,
      `minOpenSources=${minOpenSources}`,
      `maxAwards=${maxAwards}`,
      `aggregateFacts=${aggregateFacts}`,
      `policyVersion=${awardMonitoringPolicy.version || "unknown"}`,
      `report=${reportPath}`,
    ].join(" "),
  );

  const awards = explicitSlugs.length
    ? await loadAwardsBySlug(explicitSlugs)
    : await loadHighVolumeAwards({ minOpenSources, maxAwards });

  report.selected_awards = awards.map((award) => ({
    id: award.id,
    slug: award.slug,
    name: award.name,
    open_sources: award.open_sources,
  }));
  writeReport();

  if (!awards.length) {
    console.log("No awards matched the requested criteria.");
  }

  for (const award of awards) {
    if (Date.now() >= deadlineMs) {
      console.log(`TIME_BUDGET_REACHED before ${award.slug}`);
      break;
    }

    console.log(`\n=== SOURCE QUALITY TARGET ${award.open_sources} open | ${award.slug} | ${award.name}`);
    const awardResult = {
      id: award.id,
      slug: award.slug,
      name: award.name,
      open_sources_before: award.open_sources,
      cleanup_exit_code: null,
      aggregate_exit_code: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    };

    try {
      const cleanupArgs = [
        "scripts/full-source-cleanup-pass.mjs",
        `--award-slugs=${award.slug}`,
        `--safety=${safety}`,
        `--apply=${apply}`,
        `--cleanup-titles=${cleanupTitles}`,
        "--add-missing-homepages=true",
        `--source-page-size=${sourcePageSize}`,
        `--min-source-page-size=${minSourcePageSize}`,
        `--batch-size=${batchSize}`,
        `--output-prefix=${join(reportDir, `${safePathPart(award.slug)}-source-cleanup`)}`,
      ];
      awardResult.cleanup_exit_code = await runNode(cleanupArgs, { label: `cleanup:${award.slug}` });

      if (awardResult.cleanup_exit_code !== 0) {
        throw new Error(`Cleanup exited with code ${awardResult.cleanup_exit_code}`);
      }

      if (aggregateFacts && Date.now() < deadlineMs) {
        const aggregateArgs = [
          "scripts/aggregate-award-baseline-facts.mjs",
          `--award-id=${award.id}`,
          `--apply=${apply}`,
          `--force=${forceAggregateFacts}`,
          "--limit=all",
        ];
        awardResult.aggregate_exit_code = await runNode(aggregateArgs, { label: `aggregate:${award.slug}` });
        if (awardResult.aggregate_exit_code !== 0) {
          throw new Error(`Award fact aggregation exited with code ${awardResult.aggregate_exit_code}`);
        }
      }

      awardResult.finished_at = new Date().toISOString();
      report.completed_awards.push(awardResult);
    } catch (error) {
      awardResult.finished_at = new Date().toISOString();
      awardResult.error = errorMessage(error);
      report.failed_awards.push(awardResult);
      console.log(`AWARD_TARGET_FAILED ${award.slug} | ${awardResult.error}`);
      if (stopOnFailure) throw error;
    } finally {
      writeReport();
    }
  }

  report.status = report.failed_awards.length ? "completed_with_failures" : "succeeded";
} catch (error) {
  report.status = "failed";
  report.error = errorMessage(error);
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  writeReport();
  console.log(`OVERNIGHT_SOURCE_QUALITY_REPORT ${reportPath}`);
}

async function loadHighVolumeAwards({ minOpenSources: minimum, maxAwards: limit }) {
  const awards = await loadActiveAwards();
  const counts = await loadOpenSourceCountsByAward();
  return awards
    .map((award) => ({ ...award, open_sources: counts.get(award.id) || 0 }))
    .filter((award) => award.open_sources >= minimum)
    .sort((left, right) => right.open_sources - left.open_sources || left.name.localeCompare(right.name))
    .slice(0, limit);
}

async function loadAwardsBySlug(slugs) {
  const { data, error } = await supabase
    .from("shared_awards")
    .select("id,slug,name,status")
    .in("slug", slugs)
    .eq("status", "active");
  if (error) throw new Error(describeSupabaseError(error, "load selected awards"));

  const counts = await loadOpenSourceCountsByAward();
  const bySlug = new Map((data || []).map((award) => [award.slug, award]));
  return slugs
    .map((slug) => bySlug.get(slug))
    .filter(Boolean)
    .map((award) => ({ ...award, open_sources: counts.get(award.id) || 0 }));
}

async function loadActiveAwards() {
  return loadAllRows("shared_awards", "id,slug,name,status", (query) =>
    query.eq("status", "active").order("name", { ascending: true }),
  );
}

async function loadOpenSourceCountsByAward() {
  const rows = await loadAllRows("shared_award_sources", "id,shared_award_id", (query) =>
    query.eq("admin_review_status", "open").order("id", { ascending: true }),
  );
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.shared_award_id, (counts.get(row.shared_award_id) || 0) + 1);
  }
  return counts;
}

async function loadAllRows(table, columns, buildQuery) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    let query = supabase.from(table).select(columns).range(from, from + pageSize - 1);
    query = buildQuery ? buildQuery(query) : query;
    const { data, error } = await query;
    if (error) throw new Error(describeSupabaseError(error, `load ${table}`));
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function runNode(commandArgs, { label }) {
  return new Promise((resolveCommand) => {
    const started = new Date().toISOString();
    const commandRecord = {
      label,
      command: ["node", ...commandArgs],
      started_at: started,
      finished_at: null,
      exit_code: null,
    };
    report.commands.push(commandRecord);
    writeReport();

    const child = spawn(process.execPath, commandArgs, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: false,
    });

    child.on("close", (code) => {
      commandRecord.finished_at = new Date().toISOString();
      commandRecord.exit_code = code ?? 1;
      writeReport();
      resolveCommand(commandRecord.exit_code);
    });
  });
}

function writeReport() {
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}

function printHelp() {
  console.log(`Run the repeatable overnight source quality pass.

This wraps:
  1. scripts/full-source-cleanup-pass.mjs
  2. scripts/aggregate-award-baseline-facts.mjs

Common commands:
  npm run source:overnight-quality -- --hours=10 --apply=true
  npm run source:overnight-quality -- --hours=2 --apply=false --max-awards=5
  npm run source:overnight-quality -- --award-slugs=slug-one,slug-two --apply=true

Options:
  --hours=10                  Stop after this many hours.
  --apply=false               Dry-run by default. Use --apply=true to update Supabase.
  --max-awards=40             Max high-volume awards to process.
  --min-open-sources=75       Only auto-select awards with at least this many open sources.
  --award-slugs=a,b           Process specific awards instead of selecting by volume.
  --safety=full               Pass through to full-source-cleanup-pass; safe or full.
  --cleanup-titles=true       Simplify source display titles while cleaning.
  --aggregate-facts=true      Rebuild award facts from remaining source baseline facts.
  --force-aggregate-facts=true Force targeted fact rebuild after source cleanup.
  --stop-on-failure=false     Continue to the next award after a failure.
`);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) {
      parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[withoutPrefix] = next;
      index += 1;
    } else {
      parsed[withoutPrefix] = "true";
    }
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function csvList(value) {
  if (value === undefined || value === null || value === "") return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function cleanChoice(value, choices, fallback) {
  const normalized = String(value || "").toLowerCase();
  return choices.includes(normalized) ? normalized : fallback;
}

function safePathPart(value) {
  return String(value || "award").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "award";
}

function timestampForPath(value) {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

function describeSupabaseError(error, fallback) {
  if (!error) return fallback;
  return error.message || error.details || error.hint || fallback;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error || "Unknown error");
}
