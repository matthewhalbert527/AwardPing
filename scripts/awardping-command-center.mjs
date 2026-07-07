#!/usr/bin/env node
import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "status";
const profile = choiceArg(args.profile, ["catchup", "daily", "baseline", "cleanup", "snapshots"], "catchup");
const apply = boolArg(args.apply, true);
const baselineCostCapUsd = numberArg(args["baseline-cost-cap-usd"], 10);
const envPath = stringArg(
  args.env,
  existsSync(resolve(root, ".env.worker.local")) ? ".env.worker.local" : ".env.local",
);
const logRoot = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "AwardPingWorker", "logs")
  : join(root, "logs");

if (command === "help" || boolArg(args.help, false)) {
  printHelp();
} else if (command === "profiles") {
  printProfiles();
} else if (command === "status") {
  await printStatus();
} else if (command === "start") {
  startMaintenance();
} else if (command === "run") {
  await runMaintenanceForeground();
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

async function printStatus() {
  console.log("AwardPing Local Command Center");
  console.log(`Repo: ${root}`);
  console.log("");
  await printRecentDatabaseRuns();
  await printLocalProcesses();
  await printScheduledTasks();
  console.log("");
  console.log("Start catch-up:");
  console.log("  npm run command:center -- start --profile=catchup --apply=true --baseline-cost-cap-usd=10");
}

function startMaintenance() {
  mkdirSync(logRoot, { recursive: true });
  const logPath = join(logRoot, `awardping-command-center-${timestampForPath(new Date().toISOString())}-${profile}.log`);
  const output = openSync(logPath, "a");
  const child = spawn(process.execPath, maintenanceArgs(), {
    cwd: root,
    detached: true,
    env: process.env,
    stdio: ["ignore", output, output],
    windowsHide: true,
  });
  child.unref();
  closeSync(output);

  console.log(`Started ${profile} maintenance as PID ${child.pid}.`);
  console.log(`Log: ${logPath}`);
  console.log("Status:");
  console.log("  npm run command:center -- status");
}

async function runMaintenanceForeground() {
  const exitCode = await runForeground(process.execPath, maintenanceArgs());
  process.exit(exitCode);
}

function maintenanceArgs() {
  return [
    "scripts/run-awardping-maintenance.mjs",
    "--env",
    envPath,
    `--profile=${profile}`,
    `--apply=${apply}`,
    `--baseline-cost-cap-usd=${baselineCostCapUsd}`,
  ];
}

async function printRecentDatabaseRuns() {
  const supabase = supabaseFromEnv();
  if (!supabase) {
    console.log("Database runs: unavailable, missing Supabase config.");
    console.log("");
    return;
  }

  const { data, error } = await supabase
    .from("local_worker_runs")
    .select("worker_name,status,started_at,finished_at,checked_count,changed_count,failed_count,error,metadata")
    .order("started_at", { ascending: false })
    .limit(8);

  if (error) {
    console.log(`Database runs: unavailable, ${error.message}`);
    console.log("");
    return;
  }

  console.log("Recent database runs:");
  if (!data?.length) {
    console.log("  None recorded.");
  } else {
    for (const run of data) {
      const metadata = objectValue(run.metadata);
      const profileLabel = metadata.profile ? ` profile=${metadata.profile}` : "";
      const phaseLabel = Array.isArray(metadata.phases)
        ? ` phases=${metadata.phases.filter((phase) => phase?.status === "succeeded").length}/${metadata.phases.length}`
        : "";
      console.log(
        `  ${run.status.padEnd(9)} ${run.worker_name}${profileLabel}${phaseLabel} started=${formatDate(run.started_at)}`,
      );
      if (run.error) console.log(`    error=${run.error}`);
    }
  }
  console.log("");
}

async function printLocalProcesses() {
  const script = `
$rows = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match 'Run-AwardPing|run-awardping-maintenance|capture-visual-snapshots|baseline-facts|source-quality|backfill-baseline|aggregate-award' -and
    $_.CommandLine -notmatch 'awardping-command-center'
  } |
  Select-Object ProcessId, CreationDate, CommandLine
$rows | ConvertTo-Json -Depth 4
`;
  const rows = await powershellJson(script);
  console.log("Local processes:");
  if (!rows.length) {
    console.log("  None found.");
  } else {
    for (const row of rows.slice(0, 10)) {
      console.log(`  PID ${row.ProcessId}: ${trimCommand(row.CommandLine)}`);
    }
  }
  console.log("");
}

async function printScheduledTasks() {
  const script = `
$rows = Get-ScheduledTask |
  Where-Object { $_.TaskName -match 'AwardPing|awardping|PagePing|pageping' -or $_.TaskPath -match 'AwardPing|awardping|PagePing|pageping' } |
  Select-Object TaskName, State
$rows | ConvertTo-Json -Depth 4
`;
  const rows = await powershellJson(script);
  console.log("Scheduled tasks:");
  if (!rows.length) {
    console.log("  None found.");
  } else {
    for (const row of rows) {
      console.log(`  ${taskStateLabel(row.State).padEnd(10)} ${row.TaskName}`);
    }
  }
}

function powershellJson(script) {
  return new Promise((resolveRows) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolveRows([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolveRows(Array.isArray(parsed) ? parsed : parsed ? [parsed] : []);
        } catch {
          resolveRows([]);
        }
      },
    );
  });
}

function runForeground(file, commandArgs) {
  return new Promise((resolveExit) => {
    const child = spawn(file, commandArgs, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("exit", (code, signal) => resolveExit(signal ? 1 : code ?? 1));
  });
}

function supabaseFromEnv() {
  const loadedEnv = {
    ...loadEnvFile(resolve(root, envPath)),
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

function printProfiles() {
  console.log(`Profiles:
  catchup    Source cleanup, missing screenshots, Gemini Batch facts, aggregation, pruning.
  daily      Normal full daily pass.
  baseline   Gemini Batch facts and public fact aggregation.
  cleanup    Source hygiene, aggregation, snapshot retention.
  snapshots  Visual snapshot refresh.`);
}

function printHelp() {
  console.log(`AwardPing local command center.

Usage:
  npm run command:center -- status
  npm run command:center -- profiles
  npm run command:center -- start --profile=catchup --apply=true --baseline-cost-cap-usd=10
  npm run command:center -- run --profile=baseline --apply=true

Commands:
  status    Show recent Supabase worker rows, local processes, and scheduled tasks.
  start     Start a detached local maintenance run.
  run       Run maintenance in the foreground.
  profiles  List maintenance profiles.

Options:
  --profile=catchup|daily|baseline|cleanup|snapshots
  --apply=true|false
  --baseline-cost-cap-usd=10
  --env=.env.worker.local`);
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }
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
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function choiceArg(value, allowed, fallback) {
  const clean = String(value || "").trim().toLowerCase();
  return allowed.includes(clean) ? clean : fallback;
}

function stringArg(value, fallback) {
  const clean = String(value || "").trim();
  return clean || fallback;
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function trimCommand(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 150 ? `${text.slice(0, 147)}...` : text;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "unknown";
}

function taskStateLabel(value) {
  const text = String(value ?? "").trim();
  if (text === "1") return "Disabled";
  if (text === "2") return "Queued";
  if (text === "3") return "Ready";
  if (text === "4") return "Running";
  return text || "Unknown";
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}
