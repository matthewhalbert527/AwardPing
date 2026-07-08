#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
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
const host = stringArg(args.host, "127.0.0.1");
const port = numberArg(args.port, 8787);
const token = stringArg(args.token, randomBytes(18).toString("hex"));
const envPath = stringArg(
  args.env,
  existsSync(resolve(root, ".env.worker.local")) ? ".env.worker.local" : ".env.local",
);
const logRoot = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "AwardPingWorker", "logs")
  : join(root, "logs");
const CENTRAL_TIME_ZONE = "America/Chicago";

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    if (!hasValidToken(url)) {
      sendText(response, 403, "Invalid or missing command-center token.");
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, renderPage());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, await readStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/action") {
      const body = await readJsonBody(request);
      sendJson(response, 200, await runAction(body));
      return;
    }

    sendText(response, 404, "Not found.");
  } catch (error) {
    sendJson(response, 500, { ok: false, error: errorMessage(error) });
  }
});

server.listen(port, host, () => {
  console.log(`AwardPing worker control: http://${host}:${port}/?token=${token}`);
});

async function readStatus() {
  const [runs, processes, tasks] = await Promise.all([
    readRecentDatabaseRuns(),
    readWorkerProcesses(),
    readScheduledTasks(),
  ]);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    root,
    envPath,
    runs,
    processes,
    tasks,
    atomicTasks,
    profiles: maintenanceProfiles,
    scheduledWorkers,
    workerLanes,
  };
}

async function runAction(body) {
  const type = cleanText(body?.type);
  const id = cleanText(body?.id);

  if (type === "start-profile") return startProfile(id);
  if (type === "start-atomic-task") return startAtomicTask(id);
  if (type === "start-atomic-schedules") return atomicScheduleAction("start", id);
  if (type === "stop-atomic-schedules") return atomicScheduleAction("stop", id);
  if (type === "enable-atomic-schedules") return atomicScheduleAction("enable", id);
  if (type === "disable-atomic-schedules") return atomicScheduleAction("disable", id);
  if (type === "start-task") return taskAction("start", id);
  if (type === "stop-task") return taskAction("stop", id);
  if (type === "enable-task") return taskAction("enable", id);
  if (type === "disable-task") return taskAction("disable", id);
  if (type === "stop-process") return stopProcess(numberArg(id, 0));
  if (type === "start-lane-scheduled") return laneTaskAction("start", id);
  if (type === "stop-lane-scheduled") return laneTaskAction("stop", id);
  if (type === "enable-lane-scheduled") return laneTaskAction("enable", id);
  if (type === "disable-lane-scheduled") return laneTaskAction("disable", id);
  if (type === "start-all-scheduled") return startAllScheduled();
  if (type === "stop-all-workers") return stopAllWorkers();
  if (type === "enable-all-scheduled") return bulkTaskAction("enable");
  if (type === "disable-all-scheduled") return bulkTaskAction("disable");

  return { ok: false, error: "Unknown action." };
}

function startProfile(profile) {
  if (!Object.hasOwn(maintenanceProfiles, profile)) {
    return { ok: false, error: "Unknown maintenance profile." };
  }

  const logPath = startDetachedNode({
    id: profile,
    logLabel: "profile",
    commandArgs: [
      "scripts/run-awardping-maintenance.mjs",
      "--env",
      envPath,
      `--profile=${profile}`,
      "--apply=true",
      "--baseline-cost-cap-usd=10",
    ],
  });

  return {
    ok: true,
    message: `Started ${maintenanceProfiles[profile].label} as PID ${logPath.pid}.`,
    pid: logPath.pid,
    logPath: logPath.path,
  };
}

function startAtomicTask(taskId) {
  const task = atomicTasks.find((candidate) => candidate.id === taskId);
  if (!task) return { ok: false, error: "Unknown individual task." };

  const run = task.run || {};
  const commandArgs = run.kind === "maintenance"
    ? [
        "scripts/run-awardping-maintenance.mjs",
        "--env",
        envPath,
        "--profile=daily",
        `--phases=${(run.phases || []).join(",")}`,
        "--apply=true",
        "--baseline-cost-cap-usd=10",
      ]
    : [
        ...(run.args || []),
        ...(run.applyArg ? ["--apply=true"] : []),
        "--env",
        envPath,
      ];

  if (!commandArgs.length) return { ok: false, error: "Task has no runnable command." };

  const logPath = startDetachedNode({
    id: task.id,
    logLabel: "task",
    commandArgs,
  });

  return {
    ok: true,
    message: `Started ${task.label} as PID ${logPath.pid}.`,
    pid: logPath.pid,
    logPath: logPath.path,
  };
}

function startDetachedNode({ id, logLabel, commandArgs }) {
  mkdirSync(logRoot, { recursive: true });
  const logPath = join(
    logRoot,
    `awardping-command-center-web-${logLabel}-${timestampForPath(new Date().toISOString())}-${safePathPart(id)}.log`,
  );
  const output = openSync(logPath, "a");
  const child = spawn(process.execPath, commandArgs, {
    cwd: root,
    detached: true,
    env: process.env,
    stdio: ["ignore", output, output],
    windowsHide: true,
  });
  child.unref();
  closeSync(output);

  return { path: logPath, pid: child.pid };
}

async function taskAction(action, id) {
  const worker = scheduledWorkers.find((candidate) => candidate.id === id);
  if (!worker) return { ok: false, error: "Unknown scheduled worker." };

  const verb = {
    start: "Start-ScheduledTask",
    stop: "Stop-ScheduledTask",
    enable: "Enable-ScheduledTask",
    disable: "Disable-ScheduledTask",
  }[action];
  if (!verb) return { ok: false, error: "Unknown scheduled-task action." };

  const result = await powershellText(`
$name = ${psString(worker.taskName)}
${verb} -TaskName $name -ErrorAction Stop | Out-Null
Write-Output "${action} $name"
`);
  return {
    ok: result.ok,
    message: result.ok ? `${worker.label}: ${action} requested.` : result.error,
  };
}

async function laneTaskAction(action, laneId) {
  const lane = workerLanes.find((candidate) => candidate.id === laneId);
  if (!lane) return { ok: false, error: "Unknown worker lane." };

  let workerIds = new Set(lane.workerIds || []);
  if (action === "start" || action === "stop") {
    const tasks = await readScheduledTasks();
    const wantedState = action === "start" ? (state) => state === "Ready" : (state) => state === "Running";
    workerIds = new Set(
      tasks
        .filter((task) => workerIds.has(task.id) && task.exists && wantedState(task.state))
        .map((task) => task.id),
    );
  }

  const rows = [];
  for (const workerId of workerIds) {
    rows.push(await taskAction(action, workerId));
  }

  const actionLabels = {
    start: "Started",
    stop: "Stopped",
    enable: "Enabled",
    disable: "Disabled",
  };
  const successCount = rows.filter((row) => row.ok).length;
  return {
    ok: rows.every((row) => row.ok),
    message: `${actionLabels[action] || "Updated"} ${successCount} scheduled task(s) in ${lane.label}.`,
    results: rows,
  };
}

async function atomicScheduleAction(action, taskId) {
  const task = atomicTasks.find((candidate) => candidate.id === taskId);
  if (!task) return { ok: false, error: "Unknown individual task." };
  const rows = await runScheduledWorkerActions(action, task.scheduledWorkerIds || []);
  const actionLabels = {
    start: "Started",
    stop: "Stopped",
    enable: "Enabled",
    disable: "Disabled",
  };
  return {
    ok: rows.every((row) => row.ok),
    message: `${actionLabels[action] || "Updated"} ${rows.filter((row) => row.ok).length} schedule(s) for ${task.label}.`,
    results: rows,
  };
}

async function runScheduledWorkerActions(action, workerIds) {
  let ids = new Set(workerIds || []);
  if (action === "start" || action === "stop") {
    const tasks = await readScheduledTasks();
    const wantedState = action === "start" ? (state) => state === "Ready" : (state) => state === "Running";
    ids = new Set(
      tasks
        .filter((task) => ids.has(task.id) && task.exists && wantedState(task.state))
        .map((task) => task.id),
    );
  }

  const rows = [];
  for (const workerId of ids) {
    rows.push(await taskAction(action, workerId));
  }
  return rows;
}

async function startAllScheduled() {
  const tasks = await readScheduledTasks();
  const rows = [];
  for (const task of tasks.filter((candidate) => candidate.exists && candidate.state === "Ready")) {
    rows.push(await taskAction("start", task.id));
  }
  return {
    ok: rows.every((row) => row.ok),
    message: `Started ${rows.filter((row) => row.ok).length} scheduled worker task(s).`,
    results: rows,
  };
}

async function bulkTaskAction(action) {
  const rows = [];
  for (const task of scheduledWorkers) {
    rows.push(await taskAction(action, task.id));
  }
  return {
    ok: rows.every((row) => row.ok),
    message: `${action === "enable" ? "Enabled" : "Disabled"} ${rows.filter((row) => row.ok).length} scheduled worker task(s).`,
    results: rows,
  };
}

async function stopAllWorkers() {
  const tasks = await readScheduledTasks();
  const taskResults = [];
  for (const task of tasks.filter((candidate) => candidate.exists && candidate.state === "Running")) {
    taskResults.push(await taskAction("stop", task.id));
  }

  const processes = await readWorkerProcesses();
  const processResults = [];
  for (const processRow of processes) {
    processResults.push(await stopProcess(processRow.pid));
  }

  return {
    ok: taskResults.every((row) => row.ok) && processResults.every((row) => row.ok),
    message: `Stopped ${taskResults.filter((row) => row.ok).length} scheduled task(s) and ${processResults.filter((row) => row.ok).length} process(es).`,
    taskResults,
    processResults,
  };
}

async function stopProcess(pid) {
  if (!pid) return { ok: false, error: "Missing process id." };
  const processes = await readWorkerProcesses();
  const processRow = processes.find((candidate) => candidate.pid === pid);
  if (!processRow) {
    return { ok: false, error: "Process is not an allowlisted AwardPing worker." };
  }

  const result = await powershellText(`
Stop-Process -Id ${pid} -Force -ErrorAction Stop
Write-Output "stopped ${pid}"
`);
  return {
    ok: result.ok,
    message: result.ok ? `Stopped PID ${pid}.` : result.error,
  };
}

async function readRecentDatabaseRuns() {
  const supabase = supabaseFromEnv();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("local_worker_runs")
    .select("worker_name,status,started_at,finished_at,checked_count,changed_count,failed_count,error,metadata")
    .order("started_at", { ascending: false })
    .limit(12);
  if (error) return [{ error: error.message }];
  return data || [];
}

async function readWorkerProcesses() {
  const patterns = workerProcessPatterns.map(psString).join(", ");
  const rows = await powershellJson(`
$patterns = @(${patterns})
$rows = Get-CimInstance Win32_Process |
  Where-Object {
    $cmd = [string]$_.CommandLine
    if (-not $cmd) { return $false }
    if ($cmd -match 'awardping-command-center-web') { return $false }
    foreach ($pattern in $patterns) {
      if ($cmd -like "*$pattern*") { return $true }
    }
    return $false
  } |
  Select-Object @{Name='pid';Expression={$_.ProcessId}}, @{Name='createdAt';Expression={[string]$_.CreationDate}}, @{Name='command';Expression={$_.CommandLine}}
$rows | ConvertTo-Json -Depth 4
`);
  return rows.map((row) => ({
    pid: Number(row.pid),
    createdAt: cleanText(row.createdAt),
    command: cleanText(row.command),
  }));
}

async function readScheduledTasks() {
  const names = scheduledWorkers.map((worker) => psString(worker.taskName)).join(", ");
  const rows = await powershellJson(`
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
  if (-not $task) {
    [PSCustomObject]@{ taskName = $name; exists = $false; state = "Missing"; lastRunTime = ""; nextRunTime = ""; lastTaskResult = "" }
    continue
  }
  $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    taskName = $name
    exists = $true
    state = Convert-TaskState $task.State
    lastRunTime = if ($info.LastRunTime) { $info.LastRunTime.ToUniversalTime().ToString("o") } else { "" }
    nextRunTime = if ($info.NextRunTime) { $info.NextRunTime.ToUniversalTime().ToString("o") } else { "" }
    lastTaskResult = if ($info) { [string]$info.LastTaskResult } else { "" }
    triggerSummary = if ($task.Triggers) {
      ($task.Triggers | ForEach-Object {
        $type = [string]$_.CimClass.CimClassName
        $type = $type -replace '^MSFT_Task', '' -replace 'Trigger$', ''
        $start = if ($_.StartBoundary) { [string]$_.StartBoundary } else { 'on demand' }
        $repeat = if ($_.Repetition -and $_.Repetition.Interval) { " repeat $($_.Repetition.Interval)" } else { "" }
        "$type $start$repeat"
      }) -join "; "
    } else { "on demand" }
  }
}
$rows | ConvertTo-Json -Depth 4
`);
  return scheduledWorkers.map((worker) => {
    const row = rows.find((candidate) => candidate.taskName === worker.taskName) || {};
    return {
      ...worker,
      exists: Boolean(row.exists),
      state: cleanText(row.state) || "Missing",
      lastRunTime: cleanText(row.lastRunTime),
      nextRunTime: cleanText(row.nextRunTime),
      lastTaskResult: cleanText(row.lastTaskResult),
      triggerSummary: cleanText(row.triggerSummary),
    };
  });
}

function powershellJson(script) {
  return new Promise((resolveRows) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 20_000 },
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

function powershellText(script) {
  return new Promise((resolveResult) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 20_000 },
      (error, stdout, stderr) => {
        resolveResult({
          ok: !error,
          output: stdout.trim(),
          error: error ? (stderr || error.message).trim() : "",
        });
      },
    );
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

function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AwardPing Worker Control</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #172033;
      --muted: #667085;
      --line: #dbe4f0;
      --panel: #ffffff;
      --soft: #f4f7fb;
      --brand: #2f6fed;
      --brand-dark: #173f95;
      --danger: #b42318;
      --danger-soft: #fff0ed;
      --good: #027a48;
      --good-soft: #ecfdf3;
      --warn: #b54708;
      --warn-soft: #fff7ed;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--soft);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { max-width: 1220px; margin: 0 auto; padding: 28px 18px 44px; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 18px;
      margin-bottom: 18px;
    }
    h1 { margin: 0; font-size: clamp(2rem, 4vw, 3rem); line-height: 1; }
    h2 { margin: 0; font-size: 1.2rem; }
    h3 { margin: 0; font-size: 1rem; }
    p { margin: 0; color: var(--muted); line-height: 1.55; }
    code {
      display: block;
      overflow: auto;
      border-radius: 8px;
      background: #111827;
      color: #f9fafb;
      padding: 10px 12px;
      font-size: 0.84rem;
      line-height: 1.5;
      white-space: nowrap;
    }
    button {
      border: 0;
      border-radius: 8px;
      background: var(--brand);
      color: white;
      cursor: pointer;
      font-weight: 800;
      padding: 10px 12px;
      min-height: 40px;
    }
    button:hover { background: var(--brand-dark); }
    button.secondary { background: #e8eefb; color: var(--brand-dark); }
    button.secondary:hover { background: #dce7fb; }
    button.danger { background: var(--danger); }
    button.danger:hover { background: #7a271a; }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    .grid { display: grid; gap: 14px; }
    .grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 16px 42px rgba(15, 23, 42, 0.06);
      padding: 16px;
    }
    .hero {
      background: linear-gradient(135deg, #ffffff 0%, #f8fbff 55%, #eef7f4 100%);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 20px;
    }
    .hero p { max-width: 760px; margin-top: 10px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .section-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin: 22px 0 10px;
    }
    .worker-lanes {
      display: grid;
      gap: 26px;
    }
    .lane {
      border-top: 1px solid var(--line);
      padding-top: 22px;
    }
    .lane:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .lane-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: start;
      margin-bottom: 14px;
    }
    .lane-group {
      display: grid;
      gap: 8px;
      margin-top: 14px;
    }
    .lane-label {
      color: var(--muted);
      font-size: 0.73rem;
      font-weight: 900;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .lane-items {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 14px;
    }
    .card {
      display: grid;
      gap: 12px;
      align-content: start;
      min-height: 100%;
    }
    .card-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: flex-start;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: #eef4ff;
      color: var(--brand-dark);
      font-size: 0.75rem;
      font-weight: 900;
      padding: 5px 9px;
      white-space: nowrap;
    }
    .badge.good { background: var(--good-soft); color: var(--good); }
    .badge.warn { background: var(--warn-soft); color: var(--warn); }
    .badge.danger { background: var(--danger-soft); color: var(--danger); }
    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: center;
      padding: 12px 0;
      border-top: 1px solid var(--line);
    }
    .row:first-child { border-top: 0; }
    .meta { color: var(--muted); font-size: 0.88rem; }
    .toast {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 10;
      max-width: min(520px, calc(100vw - 32px));
      border-radius: 8px;
      background: #111827;
      color: white;
      padding: 12px 14px;
      box-shadow: 0 22px 60px rgba(15, 23, 42, 0.28);
      display: none;
    }
    .toast.show { display: block; }
    .toast p { color: #e5e7eb; }
    .small { font-size: 0.88rem; }
    @media (max-width: 860px) {
      header, .section-head, .lane-head, .row { grid-template-columns: 1fr; flex-direction: column; align-items: stretch; }
      .grid.cols-2, .grid.cols-3 { grid-template-columns: 1fr; }
      .actions button { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <div>
        <h1>AwardPing Worker Control</h1>
        <p>Local-only command center for the Windows worker. Use this page to start maintenance profiles, start or stop scheduled worker tasks, stop running worker processes, and inspect current status.</p>
      </div>
      <div class="actions">
        <button class="secondary" id="refresh">Refresh</button>
      </div>
    </header>

    <section class="panel">
      <div class="section-head" style="margin-top:0">
        <div>
          <h2>Global Controls</h2>
          <p>These operate only on allowlisted AwardPing scheduled tasks and worker processes.</p>
        </div>
      </div>
      <div class="actions">
        <button data-action="start-all-scheduled">Start all ready scheduled workers</button>
        <button class="danger" data-action="stop-all-workers">Stop all running workers</button>
        <button class="secondary" data-action="enable-all-scheduled">Enable all schedules</button>
        <button class="secondary" data-action="disable-all-scheduled">Disable all schedules</button>
      </div>
    </section>

    <div class="section-head">
      <div>
        <h2>Worker Lanes</h2>
        <p>Workers are grouped by outcome. Profiles start coordinated runs; scheduled workers are recurring background jobs.</p>
      </div>
    </div>
    <section class="worker-lanes" id="lanes"></section>

    <div class="section-head">
      <div>
        <h2>Running Processes</h2>
        <p>Only allowlisted AwardPing worker processes appear here.</p>
      </div>
    </div>
    <section class="panel" id="processes"></section>

    <div class="section-head">
      <div>
        <h2>Recent Worker Rows</h2>
        <p>Latest records from Supabase <code style="display:inline;padding:2px 5px">local_worker_runs</code>.</p>
      </div>
    </div>
    <section class="panel" id="runs"></section>
  </main>
  <div class="toast" id="toast"></div>
  <script>
    const token = ${JSON.stringify(token)};
    const atomicTasks = ${JSON.stringify(atomicTasks)};
    const maintenanceProfiles = ${JSON.stringify(maintenanceProfiles)};
    const scheduledWorkers = ${JSON.stringify(scheduledWorkers)};
    const workerLanes = ${JSON.stringify(workerLanes)};
    const centralDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: ${JSON.stringify(CENTRAL_TIME_ZONE)},
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    const statusClass = (value) => {
      const text = String(value || "").toLowerCase();
      if (text.includes("succeeded") || text.includes("ready")) return "good";
      if (text.includes("running") || text.includes("queued")) return "warn";
      if (text.includes("failed") || text.includes("disabled") || text.includes("missing")) return "danger";
      return "";
    };

    document.getElementById("refresh").addEventListener("click", refresh);
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => act(button.dataset.action));
    });

    async function refresh() {
      const data = await fetchJson("/api/status?token=" + token);
      renderLanes(data);
      renderProcesses(data);
      renderRuns(data);
    }

    function renderLanes(data) {
      const taskById = new Map((data.tasks || []).map((task) => [task.id, task]));
      const root = document.getElementById("lanes");
      root.innerHTML = workerLanes.map((lane) => renderLane(lane, taskById)).join("");

      root.querySelectorAll("[data-start-profile]").forEach((button) => {
        button.addEventListener("click", () => act("start-profile", button.dataset.startProfile));
      });
      root.querySelectorAll("[data-start-atomic-task]").forEach((button) => {
        button.addEventListener("click", () => act("start-atomic-task", button.dataset.startAtomicTask));
      });
      root.querySelectorAll("[data-atomic-schedule-action]").forEach((button) => {
        button.addEventListener("click", () => act(button.dataset.atomicScheduleAction, button.dataset.id));
      });
      root.querySelectorAll("[data-task-action]").forEach((button) => {
        button.addEventListener("click", () => act(button.dataset.taskAction, button.dataset.id));
      });
      root.querySelectorAll("[data-lane-action]").forEach((button) => {
        button.addEventListener("click", () => act(button.dataset.laneAction, button.dataset.id));
      });
    }

    function renderLane(lane, taskById) {
      const profiles = (lane.profileIds || [])
        .map((id) => ({ id, ...maintenanceProfiles[id] }))
        .filter((profile) => profile.label);
      const tasks = (lane.taskIds || [])
        .map((id) => atomicTasks.find((task) => task.id === id))
        .filter(Boolean);
      const workers = (lane.workerIds || [])
        .map((id) => scheduledWorkers.find((worker) => worker.id === id))
        .filter(Boolean);
      const laneActions = workers.length
        ? '<div class="actions">' +
            '<button data-lane-action="start-lane-scheduled" data-id="' + lane.id + '">Start ready schedules</button>' +
            '<button class="danger" data-lane-action="stop-lane-scheduled" data-id="' + lane.id + '">Stop lane schedules</button>' +
            '<button class="secondary" data-lane-action="enable-lane-scheduled" data-id="' + lane.id + '">Enable lane</button>' +
            '<button class="secondary" data-lane-action="disable-lane-scheduled" data-id="' + lane.id + '">Disable lane</button>' +
          '</div>'
        : '<p class="meta">Use the individual task or bundle buttons in this lane.</p>';
      const taskHtml = tasks.length
        ? '<div class="lane-group"><div class="lane-label">Individual tasks</div><div class="lane-items">' +
          tasks.map((task) => renderAtomicTaskCard(task, taskById)).join("") +
          '</div></div>'
        : "";
      const profileHtml = profiles.length
        ? '<div class="lane-group"><div class="lane-label">Bundle shortcuts</div><div class="lane-items">' +
          profiles.map(renderProfileCard).join("") +
          '</div></div>'
        : "";
      const workerHtml = workers.length
        ? '<div class="lane-group"><div class="lane-label">Installed schedules</div><div class="lane-items">' +
          workers.map((worker) => renderTaskCard(worker, taskById.get(worker.id) || worker)).join("") +
          '</div></div>'
        : "";
      return '<section class="lane" id="lane-' + lane.id + '">' +
        '<div class="lane-head">' +
          '<div><h2>' + escapeHtml(lane.label) + '</h2><p>' + escapeHtml(lane.detail) + '</p></div>' +
          laneActions +
        '</div>' +
        taskHtml +
        profileHtml +
        workerHtml +
        '</section>';
    }

    function renderAtomicTaskCard(task, taskById) {
      const schedules = (task.scheduledWorkerIds || [])
        .map((id) => taskById.get(id))
        .filter(Boolean);
      const scheduleText = schedules.length
        ? schedules.map((schedule) => {
            const trigger = schedule.triggerSummary ? ' (' + schedule.triggerSummary + ')' : '';
            return schedule.label + ': ' + (schedule.state || 'Unknown') + trigger;
          }).join(' / ')
        : 'Manual only; no Windows schedule is installed for this task.';
      const scheduleControls = schedules.length
        ? '<div class="actions">' +
            '<button class="secondary" data-atomic-schedule-action="start-atomic-schedules" data-id="' + task.id + '">Start ready schedule</button>' +
            '<button class="danger" data-atomic-schedule-action="stop-atomic-schedules" data-id="' + task.id + '">Stop schedule</button>' +
            '<button class="secondary" data-atomic-schedule-action="enable-atomic-schedules" data-id="' + task.id + '">Enable schedule</button>' +
            '<button class="secondary" data-atomic-schedule-action="disable-atomic-schedules" data-id="' + task.id + '">Disable schedule</button>' +
          '</div>'
        : '';
      return '<article class="panel card">' +
        '<div class="card-top"><h3>' + escapeHtml(task.label) + '</h3><span class="badge">Task</span></div>' +
        '<p>' + escapeHtml(task.detail) + '</p>' +
        '<p class="meta">Cost: ' + escapeHtml(task.cost || "$0 direct AI/API cost.") + '</p>' +
        '<p class="meta">Schedule: ' + escapeHtml(scheduleText) + '</p>' +
        '<div class="actions"><button data-start-atomic-task="' + task.id + '">Run task now</button></div>' +
        scheduleControls +
        '</article>';
    }

    function renderProfileCard(profile) {
      return '<article class="panel card">' +
        '<div class="card-top"><h3>' + escapeHtml(profile.label) + '</h3><span class="badge">Profile</span></div>' +
        '<p>' + escapeHtml(profile.detail) + '</p>' +
        '<p class="meta">Cost: ' + escapeHtml(profile.cost || "$0 direct AI/API cost.") + '</p>' +
        '<button data-start-profile="' + profile.id + '">Start ' + escapeHtml(profile.label) + '</button>' +
        '</article>';
    }

    function renderTaskCard(worker, task) {
      return '<article class="panel card">' +
        '<div class="card-top"><h3>' + escapeHtml(worker.label) + '</h3><span class="badge ' + statusClass(task.state) + '">' + escapeHtml(task.state || "Unknown") + '</span></div>' +
        '<p>' + escapeHtml(worker.detail) + '</p>' +
        '<p class="meta">Cost: ' + escapeHtml(worker.cost || "$0 direct AI/API cost.") + '</p>' +
        '<p class="meta">Schedule: ' + escapeHtml(task.triggerSummary || "on demand") + '</p>' +
        '<p class="meta">Last run: ' + escapeHtml(formatCentralDateTime(task.lastRunTime) || "never") + ' - Next: ' + escapeHtml(formatCentralDateTime(task.nextRunTime) || "not scheduled") + '</p>' +
        '<div class="actions">' +
          '<button data-task-action="start-task" data-id="' + worker.id + '">Start</button>' +
          '<button class="danger" data-task-action="stop-task" data-id="' + worker.id + '">Stop</button>' +
          '<button class="secondary" data-task-action="enable-task" data-id="' + worker.id + '">Enable</button>' +
          '<button class="secondary" data-task-action="disable-task" data-id="' + worker.id + '">Disable</button>' +
        '</div>' +
        '</article>';
    }

    function renderProcesses(data) {
      const root = document.getElementById("processes");
      const rows = data.processes || [];
      if (!rows.length) {
        root.innerHTML = '<p>No allowlisted worker processes are running.</p>';
        return;
      }
      root.innerHTML = rows.map((processRow) => {
        return '<div class="row">' +
          '<div><h3>PID ' + processRow.pid + '</h3><p class="meta">' + escapeHtml(processRow.command) + '</p></div>' +
          '<button class="danger" data-stop-pid="' + processRow.pid + '">Stop process</button>' +
          '</div>';
      }).join("");
      root.querySelectorAll("[data-stop-pid]").forEach((button) => {
        button.addEventListener("click", () => act("stop-process", button.dataset.stopPid));
      });
    }

    function renderRuns(data) {
      const root = document.getElementById("runs");
      const rows = data.runs || [];
      if (!rows.length) {
        root.innerHTML = '<p>No recent Supabase worker rows were found.</p>';
        return;
      }
      root.innerHTML = rows.map((run) => {
        if (run.error) return '<div class="row"><p>' + escapeHtml(run.error) + '</p></div>';
        const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {};
        const profile = metadata.profile ? " - " + metadata.profile : "";
        return '<div class="row">' +
          '<div><h3>' + escapeHtml(run.worker_name || "worker") + profile + '</h3>' +
          '<p class="meta">' + escapeHtml(formatCentralDateTime(run.started_at)) + ' - checked ' + Number(run.checked_count || 0).toLocaleString() + ' - failed ' + Number(run.failed_count || 0).toLocaleString() + '</p>' +
          (run.error ? '<p class="small">' + escapeHtml(run.error) + '</p>' : '') +
          '</div>' +
          '<span class="badge ' + statusClass(run.status) + '">' + escapeHtml(run.status || "unknown") + '</span>' +
          '</div>';
      }).join("");
    }

    function formatCentralDateTime(value) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : centralDateTimeFormatter.format(date);
    }

    async function act(type, id = "") {
      const confirmed = type.includes("stop") || type.includes("disable")
        ? window.confirm("Run " + type + (id ? " for " + id : "") + "?")
        : true;
      if (!confirmed) return;
      try {
        const data = await fetchJson("/api/action?token=" + token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type, id }),
        });
        showToast(data.ok ? "Done" : "Action failed", data.message || data.error || "");
        await refresh();
      } catch (error) {
        showToast("Action failed", error.message);
      }
    }

    async function fetchJson(path, init) {
      const response = await fetch(path, init);
      const data = await response.json().catch(() => ({ ok: false, error: "Invalid response" }));
      if (!response.ok) throw new Error(data.error || "Request failed");
      return data;
    }

    function showToast(title, text) {
      const toast = document.getElementById("toast");
      toast.innerHTML = '<strong>' + escapeHtml(title) + '</strong>' + (text ? '<p>' + escapeHtml(text) + '</p>' : '');
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 5200);
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[char]);
    }

    refresh().catch((error) => showToast("Could not load status", error.message));
    setInterval(refresh, 30000);
  </script>
</body>
</html>`;
}

function hasValidToken(url) {
  return url.searchParams.get("token") === token;
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; connect-src 'self'; img-src 'self' data:;",
  });
  response.end(html);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
  });
  response.end(JSON.stringify(value));
}

function sendText(response, status, value) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(value);
}

function readJsonBody(request) {
  return new Promise((resolveBody) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) request.destroy();
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(body || "{}"));
      } catch {
        resolveBody({});
      }
    });
  });
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

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stringArg(value, fallback) {
  const clean = cleanText(value);
  return clean || fallback;
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function safePathPart(value) {
  return String(value || "task").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "task";
}

function errorMessage(error) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}
