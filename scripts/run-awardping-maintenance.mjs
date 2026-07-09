#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));

if (boolArg(args.help, false)) {
  printHelp();
  process.exit(0);
}

const envPath = args.env
  ? String(args.env)
  : existsSync(resolve(root, ".env.worker.local"))
    ? ".env.worker.local"
    : existsSync(resolve(root, ".env.local"))
      ? ".env.local"
      : "";
const envArgs = envPath ? ["--env", envPath] : [];
const profile = cleanChoice(args.profile, ["daily", "catchup", "baseline", "cleanup", "snapshots", "discovery", "visual-review"], "daily");
const apply = boolArg(args.apply, true);
const continueOnError = boolArg(args["continue-on-error"], true);
const runStamp = timestampForPath(new Date().toISOString());
const reportDir = args["report-dir"]
  ? resolve(root, String(args["report-dir"]))
  : join(root, "reports", `maintenance-${runStamp}`);
const logDir = args["log-dir"]
  ? resolve(String(args["log-dir"]))
  : process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "AwardPingWorker", "logs")
    : join(reportDir, "logs");
const reportPath = join(reportDir, "summary.json");

const phases = csvList(args.phases).length ? csvList(args.phases) : profilePhases(profile);
const visualShards = boundedInt(args["visual-shards"], 3, 1, 12);
const visualLimit = positiveInt(args["visual-limit"], 50_000);
const visualWebConcurrency = boundedInt(args["visual-web-concurrency"], 4, 1, 8);
const visualDomainDelayMs = positiveInt(args["visual-domain-delay-ms"], 1_500);
const visualCompleteMissingBatchLimit = positiveInt(args["visual-complete-missing-batch-limit"], 250);
const visualReviewLimit = positiveInt(args["visual-review-limit"], 1000);
const visualReviewMaxRequestsPerBatch = positiveInt(args["visual-review-max-requests-per-batch"], 250);
const visualReviewInlineThreshold = positiveInt(args["visual-review-inline-threshold"], 100);
const discoveryLimit = positiveInt(args["discovery-limit"], 5_000);
const discoveryShards = boundedInt(args["discovery-shards"], 1, 1, 12);
const discoveryMaxHtmlSubpageDiscoveries = boundedInt(args["discovery-max-html-subpage-discoveries"], 8, 0, 25);
const discoveryMaxPerAward = boundedInt(args["discovery-max-per-award"], 5, 0, 500);
const discoveryMaxPerSource = boundedInt(args["discovery-max-per-source"], 3, 0, 100);
const discoveryMaxPerDomain = boundedInt(args["discovery-max-per-domain"], 100, 0, 10_000);
const baselineLimit = positiveInt(args["baseline-limit"], 50_000);
const baselineMaxCalls = nonNegativeInt(args["baseline-max-calls"], 50_000);
const baselineCostCapUsd = nonNegativeNumber(args["baseline-cost-cap-usd"], 10);
const baselineBatchMaxRequests = positiveInt(args["baseline-batch-max-requests"], 250);
const baselineBatchParallelJobs = positiveInt(args["baseline-batch-parallel-jobs"], 4);
const baselineForce = boolArg(args["baseline-force"], false);
const sourceQualityHours = positiveNumber(args["source-quality-hours"], 10);
const sourceQualityMaxAwards = positiveInt(args["source-quality-max-awards"], 90);
const sourceQualityMinOpenSources = positiveInt(args["source-quality-min-open-sources"], 75);
const sourceQualitySafety = cleanChoice(args["source-quality-safety"], ["safe", "full"], "full");
const sourceQualityCleanupTitles = boolArg(args["source-quality-cleanup-titles"], true);
const aggregateLimit = stringArg(args["aggregate-limit"], "all");
const aggregateForce = boolArg(args["aggregate-force"], true);
const pruneKeep = boundedInt(args["prune-keep"], 2, 1, 20);
const pruneMaxBatches = positiveInt(args["prune-max-batches"], 100);

mkdirSync(reportDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

const report = {
  started_at: new Date().toISOString(),
  finished_at: null,
  status: "running",
  profile,
  apply,
  env_path: envPath || null,
  report_path: reportPath,
  log_dir: logDir,
  continue_on_error: continueOnError,
  phases_requested: phases,
  phases: [],
};
const maintenanceRun = await createMaintenanceWorkerRun().catch((error) => {
  console.warn(`AWARDPING_MAINTENANCE_DB_SYNC_UNAVAILABLE ${errorMessage(error)}`);
  return null;
});

writeReport();
await syncMaintenanceWorkerRun("running");

console.log(
  [
    "AWARDPING_MAINTENANCE_START",
    `profile=${profile}`,
    `apply=${apply}`,
    `phases=${phases.join(",")}`,
    `report=${reportPath}`,
  ].join(" "),
);

try {
  for (const phase of phases) {
    if (phase === "health") await runHealth();
    else if (phase === "prune-history") await runPruneHistory();
    else if (phase === "source-quality") await runSourceQuality();
    else if (phase === "change-event-noise") await runChangeEventNoiseCleanup();
    else if (phase === "source-discovery") await runSourceDiscovery();
    else if (phase === "visual") await runVisualSnapshots(false);
    else if (phase === "visual-missing") await runVisualSnapshots(true);
    else if (phase === "visual-review-batch") await runVisualReviewBatch();
    else if (phase === "baseline-facts") await runBaselineFacts();
    else if (phase === "aggregate-facts") await runAggregateFacts();
    else {
      await recordSkippedPhase(phase, `Unknown phase "${phase}".`);
    }
  }

  report.status = report.phases.some((phase) => phase.status === "failed")
    ? "completed_with_failures"
    : "succeeded";
} catch (error) {
  report.status = "failed";
  report.error = errorMessage(error);
  await syncMaintenanceWorkerRun("failed", errorMessage(error));
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  writeReport();
  await syncMaintenanceWorkerRun(report.status === "succeeded" ? "succeeded" : "failed", report.error || null);
  console.log(`AWARDPING_MAINTENANCE_REPORT ${reportPath}`);
}

async function runHealth() {
  await runPhase("health", ["scripts/check-supabase-health.mjs", ...envArgs], {
    blockOnFailure: true,
  });
}

async function runPruneHistory() {
  await runPhase("prune-history", [
    "scripts/prune-snapshot-history.mjs",
    ...envArgs,
    `--apply=${apply}`,
    `--keep=${pruneKeep}`,
    `--max-batches=${pruneMaxBatches}`,
  ]);
}

async function runSourceQuality() {
  await runPhase("source-quality", [
    "scripts/run-overnight-source-quality-pass.mjs",
    ...envArgs,
    `--apply=${apply}`,
    `--hours=${sourceQualityHours}`,
    `--max-awards=${sourceQualityMaxAwards}`,
    `--min-open-sources=${sourceQualityMinOpenSources}`,
    `--safety=${sourceQualitySafety}`,
    `--cleanup-titles=${sourceQualityCleanupTitles}`,
    "--aggregate-facts=false",
    "--force-aggregate-facts=false",
    "--stop-on-failure=false",
  ]);
}

async function runChangeEventNoiseCleanup() {
  await runPhase("change-event-noise", [
    "scripts/cleanup-change-event-noise.mjs",
    ...envArgs,
    `--apply=${apply}`,
    "--limit=100000",
  ]);
}

async function runVisualSnapshots(completeMissing) {
  const jobs = [];
  for (let shardIndex = 0; shardIndex < visualShards; shardIndex += 1) {
    const phaseName = completeMissing
      ? `visual-missing-shard-${shardIndex + 1}-of-${visualShards}`
      : `visual-shard-${shardIndex + 1}-of-${visualShards}`;
    const commandArgs = [
      "scripts/capture-visual-snapshots.mjs",
      ...envArgs,
      "--all=true",
      `--limit=${visualLimit}`,
      `--domain-delay-ms=${visualDomainDelayMs}`,
      `--web-concurrency=${visualWebConcurrency}`,
      `--shard-count=${visualShards}`,
      `--shard-index=${shardIndex}`,
      "--extract-baseline-info=false",
      completeMissing ? "--capture-profile=baseline-rich" : "--capture-profile=stable-daily",
      completeMissing ? "--visual-review-mode=none" : "--visual-review-mode=batch",
      "--discovery-mode=false",
      "--discover-pdf-subpages=false",
      "--discover-html-subpages=false",
      "--max-html-subpage-discoveries=0",
    ];

    if (completeMissing) {
      commandArgs.push(
        "--complete-missing-baselines=true",
        "--skip-existing-baseline=true",
        "--baseline-refresh=true",
        "--interpret-visual-changes=false",
        "--visual-review-mode=none",
        `--complete-missing-batch-limit=${visualCompleteMissingBatchLimit}`,
      );
    }

    jobs.push(runPhase(phaseName, commandArgs));
  }

  await Promise.all(jobs);
}

async function runSourceDiscovery() {
  const jobs = [];
  for (let shardIndex = 0; shardIndex < discoveryShards; shardIndex += 1) {
    const phaseName = `source-discovery-shard-${shardIndex + 1}-of-${discoveryShards}`;
    const commandArgs = [
      "scripts/capture-visual-snapshots.mjs",
      ...envArgs,
      "--all=true",
      `--limit=${discoveryLimit}`,
      `--domain-delay-ms=${visualDomainDelayMs}`,
      `--web-concurrency=${visualWebConcurrency}`,
      `--shard-count=${discoveryShards}`,
      `--shard-index=${shardIndex}`,
      "--extract-baseline-info=false",
      "--backfill-baseline-info=false",
      "--capture-profile=discovery",
      "--interpret-visual-changes=false",
      "--visual-review-mode=none",
      "--discovery-mode=true",
      "--discover-pdf-subpages=true",
      "--discover-html-subpages=true",
      `--max-html-subpage-discoveries=${discoveryMaxHtmlSubpageDiscoveries}`,
      `--max-discoveries-per-award=${discoveryMaxPerAward}`,
      `--max-discoveries-per-source=${discoveryMaxPerSource}`,
      `--max-discoveries-per-domain=${discoveryMaxPerDomain}`,
    ];
    jobs.push(runPhase(phaseName, commandArgs));
  }

  await Promise.all(jobs);
}

async function runVisualReviewBatch() {
  await runPhase("visual-review-batch", [
    "scripts/process-visual-review-batch.mjs",
    ...envArgs,
    `--limit=${visualReviewLimit}`,
    `--max-requests-per-batch=${visualReviewMaxRequestsPerBatch}`,
    `--inline-threshold=${visualReviewInlineThreshold}`,
    `--apply=${apply}`,
  ]);
}

async function runBaselineFacts() {
  const commandArgs = [
    "scripts/backfill-baseline-facts.mjs",
    ...envArgs,
    "--ai-provider=gemini",
    "--model=gemini-2.5-flash-lite",
    "--gemini-api-mode=batch",
    `--gemini-batch-max-requests=${baselineBatchMaxRequests}`,
    `--gemini-batch-parallel-jobs=${baselineBatchParallelJobs}`,
    `--limit=${baselineLimit}`,
    `--gemini-api-max-requests=${baselineMaxCalls}`,
    `--gemini-api-max-submitted-requests=${baselineMaxCalls}`,
    `--gemini-api-daily-cost-cap-usd=${baselineCostCapUsd}`,
    `--apply=${apply}`,
  ];
  if (baselineForce) commandArgs.push("--force=true");
  await runPhase("baseline-facts", commandArgs);
}

async function runAggregateFacts() {
  await runPhase("aggregate-facts", [
    "scripts/aggregate-award-baseline-facts.mjs",
    ...envArgs,
    `--apply=${apply}`,
    `--force=${aggregateForce}`,
    `--limit=${aggregateLimit}`,
  ]);
}

async function recordSkippedPhase(name, reason) {
  const phase = {
    name,
    status: "skipped",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    reason,
  };
  report.phases.push(phase);
  writeReport();
  await syncMaintenanceWorkerRun("running");
  console.log(`AWARDPING_MAINTENANCE_SKIP ${name} reason=${reason}`);
}

async function runPhase(name, commandArgs, options = {}) {
  const startedAt = new Date().toISOString();
  const logPath = join(logDir, `awardping-maintenance-${runStamp}-${safePathPart(name)}.log`);
  const phase = {
    name,
    command: [process.execPath, ...commandArgs].join(" "),
    log_path: logPath,
    started_at: startedAt,
    finished_at: null,
    status: "running",
    exit_code: null,
  };
  report.phases.push(phase);
  writeReport();
  await syncMaintenanceWorkerRun("running");

  console.log(`AWARDPING_MAINTENANCE_PHASE_START ${name} log=${logPath}`);
  const exitCode = await runCommand(commandArgs, logPath);
  phase.exit_code = exitCode;
  phase.finished_at = new Date().toISOString();
  phase.status = exitCode === 0 ? "succeeded" : "failed";
  writeReport();
  await syncMaintenanceWorkerRun("running");

  if (exitCode !== 0) {
    const message = `${name} failed with exit code ${exitCode}; see ${logPath}`;
    console.log(`AWARDPING_MAINTENANCE_PHASE_FAILED ${message}`);
    if (options.blockOnFailure || !continueOnError) throw new Error(message);
    return phase;
  }

  console.log(`AWARDPING_MAINTENANCE_PHASE_DONE ${name}`);
  return phase;
}

function runCommand(commandArgs, logPath) {
  return new Promise((resolveExit, reject) => {
    const log = createWriteStream(logPath, { flags: "a" });
    log.write(`COMMAND ${process.execPath} ${commandArgs.join(" ")}\nSTART ${new Date().toISOString()}\n`);
    const child = spawn(process.execPath, commandArgs, {
      cwd: root,
      env: process.env,
      windowsHide: true,
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.once("error", (error) => {
      log.write(`ERROR ${error.message}\n`);
      log.end();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      log.write(`FINISH ${new Date().toISOString()} code=${code ?? ""} signal=${signal ?? ""}\n`);
      log.end();
      resolveExit(signal ? 1 : code ?? 1);
    });
  });
}

function profilePhases(value) {
  if (value === "catchup") {
    return ["health", "source-quality", "change-event-noise", "visual-missing", "baseline-facts", "aggregate-facts", "prune-history"];
  }
  if (value === "baseline") return ["health", "baseline-facts", "aggregate-facts"];
  if (value === "cleanup") return ["health", "source-quality", "change-event-noise", "aggregate-facts", "prune-history"];
  if (value === "snapshots") return ["health", "visual"];
  if (value === "visual-review") return ["health", "visual-review-batch"];
  if (value === "discovery") {
    return ["health", "source-quality", "source-discovery", "baseline-facts", "aggregate-facts", "prune-history"];
  }
  return ["health", "visual", "visual-review-batch", "baseline-facts", "aggregate-facts", "source-quality", "change-event-noise", "prune-history"];
}

function writeReport() {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}

async function createMaintenanceWorkerRun() {
  const supabase = supabaseFromEnv();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      worker_name: "local-maintenance-runner",
      status: "running",
      ai_provider: phases.includes("baseline-facts") || phases.includes("visual-review-batch") ? "gemini" : null,
      initial_count: phases.length,
      metadata: maintenanceRunMetadata(),
    })
    .select("id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return { id: data?.id || null, supabase };
}

async function syncMaintenanceWorkerRun(status = "running", error = null) {
  if (!maintenanceRun?.id || !maintenanceRun.supabase) return;
  const failedCount = report.phases.filter((phase) => phase.status === "failed").length;
  const succeededCount = report.phases.filter((phase) => phase.status === "succeeded").length;
  const finished = status === "succeeded" || status === "failed";

  const { error: updateError } = await maintenanceRun.supabase
    .from("local_worker_runs")
    .update({
      status,
      changed_count: succeededCount,
      checked_count: report.phases.length,
      failed_count: failedCount,
      error,
      finished_at: finished ? report.finished_at || new Date().toISOString() : null,
      metadata: maintenanceRunMetadata(),
    })
    .eq("id", maintenanceRun.id);

  if (updateError) {
    console.warn(`AWARDPING_MAINTENANCE_DB_SYNC_FAILED ${updateError.message}`);
  }
}

function maintenanceRunMetadata() {
  return {
    kind: "maintenance",
    profile,
    apply,
    pid: process.pid,
    report_path: reportPath,
    log_dir: logDir,
    env_path: envPath || null,
    discovery_options: {
      limit: discoveryLimit,
      shards: discoveryShards,
      max_html_subpage_discoveries: discoveryMaxHtmlSubpageDiscoveries,
      max_per_award: discoveryMaxPerAward,
      max_per_source: discoveryMaxPerSource,
      max_per_domain: discoveryMaxPerDomain,
    },
    phases_requested: phases,
    phases: report.phases.map((phase) => ({
      name: phase.name,
      status: phase.status,
      started_at: phase.started_at,
      finished_at: phase.finished_at,
      exit_code: phase.exit_code,
      log_path: phase.log_path,
    })),
    started_at: report.started_at,
    finished_at: report.finished_at,
    status: report.status,
    updated_at: new Date().toISOString(),
    source: "local_command_center",
  };
}

function supabaseFromEnv() {
  const loadedEnv = {
    ...loadEnvFile(envPath ? resolve(root, envPath) : ""),
    ...process.env,
  };
  const supabaseUrl = loadedEnv.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = loadedEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
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

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function csvList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanChoice(value, allowed, fallback) {
  const clean = String(value || "").trim().toLowerCase();
  return allowed.includes(clean) ? clean : fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boundedInt(value, fallback, min, max) {
  return Math.min(max, Math.max(min, positiveInt(value, fallback)));
}

function positiveNumber(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function stringArg(value, fallback) {
  const clean = String(value ?? "").trim();
  return clean || fallback;
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function safePathPart(value) {
  return String(value || "phase").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "phase";
}

function errorMessage(error) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}

function printHelp() {
  console.log(`Run AwardPing maintenance from one coordinated entrypoint.

Examples:
  node scripts/run-awardping-maintenance.mjs --profile=catchup --apply=true
  node scripts/run-awardping-maintenance.mjs --profile=baseline --baseline-cost-cap-usd=10
  node scripts/run-awardping-maintenance.mjs --phases=health,baseline-facts,aggregate-facts

Profiles:
  daily      health, visual, baseline-facts, aggregate-facts, source-quality, prune-history
  catchup    health, source-quality, visual-missing, baseline-facts, aggregate-facts, prune-history
  baseline   health, baseline-facts, aggregate-facts
  cleanup    health, source-quality, aggregate-facts, prune-history
  snapshots  health, visual

Useful options:
  --apply=true|false
  --continue-on-error=true|false
  --visual-shards=3
  --baseline-cost-cap-usd=10
  --baseline-limit=50000
  --source-quality-hours=10
  --source-quality-max-awards=90
`);
}
