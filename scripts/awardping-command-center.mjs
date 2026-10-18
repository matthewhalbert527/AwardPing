#!/usr/bin/env node
import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  atomicTasks,
  maintenanceProfiles,
  scheduledWorkers,
  workerLanes,
  workerProcessPatterns,
} from "./awardping-worker-catalog.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "status";
const profile = stringArg(args.profile, "snapshots").toLowerCase();
const taskId = stringArg(args.task, "");
const apply = boolArg(args.apply, true);
const envPath = stringArg(
  args.env,
  existsSync(resolve(root, ".env.worker.local")) ? ".env.worker.local" : ".env.local",
);
const logRoot = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "AwardPingWorker", "logs")
  : join(root, "logs");
const CENTRAL_TIME_ZONE = "America/Chicago";
const centralDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

if (command === "help" || boolArg(args.help, false)) {
  printHelp();
} else if (command === "profiles") {
  printProfiles();
} else if (command === "tasks") {
  printAtomicTasks();
} else if (command === "status") {
  await printStatus();
} else if (command === "start") {
  assertKnownProfile();
  startMaintenance();
} else if (command === "run") {
  assertKnownProfile();
  await runMaintenanceForeground();
} else if (command === "start-task") {
  startAtomicTaskDetached();
} else if (command === "run-task") {
  await runAtomicTaskForeground();
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
  await printWorkerLanes();
  console.log("");
  console.log("Run a bounded manual screenshot capture:");
  console.log("  npm run command:center -- start --profile=snapshots --apply=true");
  console.log("Start one current zero-cost task:");
  console.log("  npm run command:center -- start-task --task=reconcile-awards");
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

function startAtomicTaskDetached() {
  const task = findAtomicTask();
  mkdirSync(logRoot, { recursive: true });
  const logPath = join(
    logRoot,
    `awardping-command-center-task-${timestampForPath(new Date().toISOString())}-${safePathPart(task.id)}.log`,
  );
  const output = openSync(logPath, "a");
  const child = spawn(process.execPath, atomicTaskArgs(task), {
    cwd: root,
    detached: true,
    env: process.env,
    stdio: ["ignore", output, output],
    windowsHide: true,
  });
  child.unref();
  closeSync(output);

  console.log(`Started ${task.label} as PID ${child.pid}.`);
  console.log(`Log: ${logPath}`);
  console.log("Status:");
  console.log("  npm run command:center -- status");
}

async function runAtomicTaskForeground() {
  const task = findAtomicTask();
  const exitCode = await runForeground(process.execPath, atomicTaskArgs(task));
  process.exit(exitCode);
}

function maintenanceArgs() {
  return [
    "scripts/run-awardping-maintenance.mjs",
    "--env",
    envPath,
    `--profile=${profile}`,
    `--apply=${apply}`,
  ];
}

function atomicTaskArgs(task) {
  const run = task.run || {};
  if (run.kind === "maintenance") {
    return [
      "scripts/run-awardping-maintenance.mjs",
      "--env",
      envPath,
      "--profile=task",
      `--phases=${(run.phases || []).join(",")}`,
      `--apply=${apply}`,
    ];
  }
  return [
    ...(run.args || []),
    ...(run.applyArg ? [`--apply=${apply}`] : []),
    "--env",
    envPath,
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
  const pattern = workerProcessPatterns.map(escapeRegex).join("|");
  const script = `
$rows = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match ${psString(pattern)} -and
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

async function printWorkerLanes() {
  const names = scheduledWorkers.map((worker) => psString(worker.taskName)).join(", ");
  const script = `
function Convert-TaskState($State) {
  $text = [string]$State
  if ($text -eq "1") { return "Disabled" }
  if ($text -eq "2") { return "Queued" }
  if ($text -eq "3") { return "Ready" }
  if ($text -eq "4") { return "Running" }
  return $text
}
$names = @(${names})
$rows = foreach ($name in $names) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    TaskName = $name
    State = if ($task) { Convert-TaskState $task.State } else { "Missing" }
  }
}
$rows | ConvertTo-Json -Depth 4
`;
  const rows = await powershellJson(script);
  const taskByName = new Map(rows.map((row) => [row.TaskName, row]));
  console.log("Worker lanes:");
  for (const lane of workerLanes) {
    console.log(`  ${lane.label}`);
    for (const profileId of lane.profileIds || []) {
      const profile = maintenanceProfiles[profileId];
      if (profile) console.log(`    profile   ${profileId.padEnd(10)} ${profile.label} cost=${profile.cost || "$0 direct AI/API cost."}`);
    }
    for (const id of lane.taskIds || []) {
      const task = atomicTasks.find((candidate) => candidate.id === id);
      if (task) console.log(`    task      ${id.padEnd(10)} ${task.label} cost=${task.cost || "$0 direct AI/API cost."}`);
    }
    for (const workerId of lane.workerIds || []) {
      const worker = scheduledWorkers.find((candidate) => candidate.id === workerId);
      if (!worker) continue;
      const state = taskByName.get(worker.taskName)?.State || "Missing";
      console.log(`    ${taskStateLabel(state).padEnd(9)} ${worker.label} cost=${worker.cost || "$0 direct AI/API cost."}`);
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
  console.log("Worker lanes and profiles:");
  for (const lane of workerLanes) {
    console.log(`  ${lane.label}`);
    console.log(`    ${lane.detail}`);
    for (const profileId of lane.profileIds || []) {
      const profile = maintenanceProfiles[profileId];
      if (profile) console.log(`    profile ${profileId.padEnd(9)} ${profile.label} cost=${profile.cost || "$0 direct AI/API cost."}`);
    }
    for (const id of lane.taskIds || []) {
      const task = atomicTasks.find((candidate) => candidate.id === id);
      if (task) console.log(`    task    ${id.padEnd(9)} ${task.label} cost=${task.cost || "$0 direct AI/API cost."}`);
    }
    for (const workerId of lane.workerIds || []) {
      const worker = scheduledWorkers.find((candidate) => candidate.id === workerId);
      if (worker) console.log(`    worker  ${workerId.padEnd(9)} ${worker.label} cost=${worker.cost || "$0 direct AI/API cost."}`);
    }
  }
}

function printAtomicTasks() {
  console.log("Individual tasks:");
  for (const lane of workerLanes) {
    const tasks = (lane.taskIds || [])
      .map((id) => atomicTasks.find((candidate) => candidate.id === id))
      .filter(Boolean);
    if (!tasks.length) continue;
    console.log(`  ${lane.label}`);
    for (const task of tasks) {
      const scheduleLabel = task.scheduledWorkerIds?.length
        ? ` schedules=${task.scheduledWorkerIds.join(",")}`
        : " manual-only";
      console.log(`    ${task.id.padEnd(18)} ${task.label}${scheduleLabel} cost=${task.cost || "$0 direct AI/API cost."}`);
    }
  }
}

function printHelp() {
  console.log(`AwardPing local command center.

Usage:
  npm run command:center -- status
  npm run command:center -- profiles
  npm run command:center -- tasks
  npm run command:center -- start --profile=snapshots --apply=true
  npm run command:center -- run --profile=discovery --apply=true
  npm run command:center -- start-task --task=source-intake
  npm run command:center -- run-task --task=reconcile-awards

Commands:
  status    Show recent Supabase worker rows, local processes, and scheduled tasks.
  start     Start a detached local maintenance run.
  run       Run maintenance in the foreground.
  profiles  List maintenance profiles.
  tasks     List individual runnable tasks.
  start-task Start one detached individual task.
  run-task   Run one individual task in the foreground.

Options:
  --profile=${Object.keys(maintenanceProfiles).join("|")}
  --task=${atomicTasks.map((task) => task.id).join("|")}
  --apply=true|false
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

function stringArg(value, fallback) {
  const clean = String(value || "").trim();
  return clean || fallback;
}

function assertKnownProfile() {
  if (Object.hasOwn(maintenanceProfiles, profile)) return;
  console.error(`Unknown or retired profile: ${profile}`);
  console.error(`Current profiles: ${Object.keys(maintenanceProfiles).join(", ")}`);
  process.exit(1);
}

function findAtomicTask() {
  const task = atomicTasks.find((candidate) => candidate.id === taskId);
  if (task) return task;
  console.error(`Unknown task: ${taskId || "(missing)"}`);
  console.error(`Known tasks: ${atomicTasks.map((candidate) => candidate.id).join(", ")}`);
  process.exit(1);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function trimCommand(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 150 ? `${text.slice(0, 147)}...` : text;
}

function formatDate(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : centralDateTimeFormatter.format(date);
}

function taskStateLabel(value) {
  const text = String(value ?? "").trim();
  if (text === "1") return "Disabled";
  if (text === "2") return "Queued";
  if (text === "3") return "Ready";
  if (text === "4") return "Running";
  return text || "Unknown";
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function psString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function safePathPart(value) {
  return String(value || "task").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "task";
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}
