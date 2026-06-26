#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, createWriteStream, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const apply = boolArg(args.apply, false);
const skipCleanup = boolArg(args["skip-cleanup"], false);
const skipPrune = boolArg(args["skip-prune"], false);
const skipTitles = boolArg(args["skip-titles"], false);
const skipSnapshots = boolArg(args["skip-snapshots"], false);
const detachedSnapshots = boolArg(args["detached-snapshots"], true);
const titleLimit = nonNegativeInt(args["title-limit"], 100);
const snapshotShards = boundedInt(args["snapshot-shards"], 3, 1, 12);
const snapshotBatchLimit = positiveInt(args["snapshot-batch-limit"], 2500);
const snapshotLimit = positiveInt(args["snapshot-limit"], 50000);
const webConcurrency = boundedInt(args["web-concurrency"], 2, 1, 6);
const geminiApiMaxCalls = nonNegativeInt(args["gemini-api-max-calls"], 0);
const costCapUsd = nonNegativeNumber(args["gemini-api-daily-cost-cap-usd"], 2);
const logDir = resolve(
  String(
    args["log-dir"] ||
      process.env.AWARDPING_PREFLIGHT_LOG_DIR ||
      join(process.env.LOCALAPPDATA || join(root, "reports"), "AwardPingWorker", "logs"),
  ),
);
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const summary = {
  started_at: new Date().toISOString(),
  apply,
  log_dir: logDir,
  phases: [],
  snapshot_processes: [],
};

mkdirSync(logDir, { recursive: true });

console.log(
  JSON.stringify(
    {
      runner: "source-preflight",
      apply,
      skipCleanup,
      skipPrune,
      skipTitles,
      titleLimit,
      skipSnapshots,
      detachedSnapshots,
      snapshotShards,
      snapshotBatchLimit,
      snapshotLimit,
      webConcurrency,
      geminiApiMaxCalls,
      costCapUsd,
      logDir,
    },
    null,
    2,
  ),
);

if (!apply) {
  console.log("DRY_RUN_ONLY: pass --apply=true to move sources to review_later, prune dead rows, and update titles.");
}

if (!skipCleanup) {
  runPhase("cleanup-source-failures", [
    "scripts/cleanup-source-failures.mjs",
    `--dry-run=${!apply}`,
    "--include-obvious-active=true",
    "--limit=30000",
  ]);
}

if (!skipPrune) {
  runPhase("prune-dead-shared-sources", [
    "scripts/prune-dead-shared-sources.mjs",
    `--apply=${apply}`,
    "--min-failures=3",
  ]);
}

if (!skipTitles && titleLimit > 0) {
  runPhase("backfill-source-page-titles", [
    "scripts/backfill-source-page-titles.mjs",
    `--apply=${apply}`,
    `--limit=${titleLimit}`,
    "--model=gemini-2.5-flash-lite",
  ]);
}

if (!skipSnapshots) {
  for (let shardIndex = 0; shardIndex < snapshotShards; shardIndex += 1) {
    const shardNumber = shardIndex + 1;
    const logPath = join(logDir, `awardping-source-preflight-snapshot-${runStamp}-shard-${shardNumber}-of-${snapshotShards}.log`);
    const commandArgs = [
      "scripts/capture-visual-snapshots.mjs",
      "--all=true",
      "--complete-missing-baselines=true",
      `--complete-missing-batch-limit=${snapshotBatchLimit}`,
      `--limit=${snapshotLimit}`,
      `--shard-count=${snapshotShards}`,
      `--shard-index=${shardIndex}`,
      `--web-concurrency=${webConcurrency}`,
      "--extract-baseline-info=false",
      "--backfill-baseline-info=false",
      "--interpret-visual-changes=false",
      "--prioritize-missing-baselines=true",
      "--prioritize-issue-sources=true",
      "--skip-existing-baseline=true",
      "--r2-snapshot-sync=true",
      "--r2-repair-missing-snapshots=true",
      "--discover-pdf-subpages=false",
      "--discover-html-subpages=false",
      "--max-html-subpage-discoveries=0",
      "--ai-provider=gemini",
      "--gemini-api-pricing-mode=standard",
      `--gemini-api-max-calls=${geminiApiMaxCalls}`,
      `--gemini-api-daily-cost-cap-usd=${costCapUsd}`,
    ];

    if (detachedSnapshots) {
      startDetachedSnapshotShard(shardNumber, snapshotShards, commandArgs, logPath);
    } else {
      runPhase(`snapshot-shard-${shardNumber}-of-${snapshotShards}`, commandArgs, { logPath });
    }
  }
}

summary.finished_at = new Date().toISOString();
console.log(JSON.stringify(summary, null, 2));

function runPhase(name, commandArgs, options = {}) {
  const startedAt = new Date().toISOString();
  const logPath = options.logPath || join(logDir, `awardping-source-preflight-${runStamp}-${name}.log`);
  console.log(`PREFLIGHT_PHASE_START ${name} log=${logPath}`);
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  createWriteStream(logPath, { flags: "a" }).end(output);
  if (output.trim()) process.stdout.write(output);

  const phase = {
    name,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: result.status === 0 ? "succeeded" : "failed",
    exit_code: result.status,
    log_path: logPath,
  };
  summary.phases.push(phase);

  if (result.error) {
    phase.status = "failed";
    phase.error = result.error.message;
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${name} failed with exit code ${result.status}; see ${logPath}`);
  }
  console.log(`PREFLIGHT_PHASE_DONE ${name}`);
}

function startDetachedSnapshotShard(shardNumber, shardCount, commandArgs, logPath) {
  appendFileSync(
    logPath,
    `PREFLIGHT_SNAPSHOT_SHARD_START shard=${shardNumber}/${shardCount} at=${new Date().toISOString()}\n` +
      `${process.execPath} ${commandArgs.join(" ")}\n`,
    "utf8",
  );
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, commandArgs, {
    cwd: root,
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  closeSync(fd);
  child.unref();

  const record = {
    shard: shardNumber,
    shard_count: shardCount,
    pid: child.pid,
    log_path: logPath,
    status: "started",
  };
  summary.snapshot_processes.push(record);
  console.log(`PREFLIGHT_SNAPSHOT_STARTED shard=${shardNumber}/${shardCount} pid=${child.pid} log=${logPath}`);
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

function nonNegativeInt(value, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function boundedInt(value, fallback, min, max) {
  return Math.min(max, Math.max(min, positiveInt(value, fallback)));
}

function nonNegativeNumber(value, fallback) {
  const number = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
