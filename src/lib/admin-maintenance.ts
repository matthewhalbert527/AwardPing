import "server-only";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_BASELINE_COST_CAP_USD,
  type MaintenanceProfileId,
} from "@/lib/maintenance-profiles";

export type MaintenanceRunnerState = {
  workerAppDir: string;
  runnerPath: string;
  runnerExists: boolean;
  controlAvailable: boolean;
  unavailableReason: string;
  hostedRuntime: boolean;
};

export type MaintenanceCommandOptions = {
  apply?: boolean;
  baselineCostCapUsd?: number;
};

export type MaintenanceReportPhase = {
  name?: string;
  status?: string;
  started_at?: string;
  finished_at?: string | null;
  exit_code?: number | null;
  log_path?: string;
};

export type MaintenanceReport = {
  path: string;
  started_at?: string;
  finished_at?: string | null;
  status?: string;
  profile?: string;
  apply?: boolean;
  phases?: MaintenanceReportPhase[];
};

const runnerFile = "run-awardping-maintenance.mjs";

export function getMaintenanceRunnerState(): MaintenanceRunnerState {
  const explicitAppDir = cleanText(
    process.env.AWARDPING_WORKER_APP_DIR || process.env.AWARDPING_MAINTENANCE_APP_DIR,
  );
  const defaultWorkerAppDir = defaultLocalWorkerAppDir();
  const workerAppDir = explicitAppDir || defaultWorkerAppDir;
  const runnerPath =
    cleanText(process.env.AWARDPING_MAINTENANCE_RUNNER) ||
    (workerAppDir ? join(workerAppDir, "scripts", runnerFile) : "");

  const runnerExists = existsSync(runnerPath);
  const hostedRuntime = isHostedRuntime();
  const disabled = process.env.AWARDPING_ADMIN_DISABLE_LOCAL_MAINTENANCE === "1";
  const controlAvailable = runnerExists && !hostedRuntime && !disabled;
  const unavailableReason = controlAvailable
    ? ""
    : hostedRuntime
      ? "Direct worker control is unavailable from the hosted deployment."
      : disabled
        ? "Direct worker control is disabled by AWARDPING_ADMIN_DISABLE_LOCAL_MAINTENANCE."
        : "The local maintenance runner was not found on this server.";

  return {
    workerAppDir: workerAppDir ? resolve(workerAppDir) : "",
    runnerPath: runnerPath ? resolve(runnerPath) : "",
    runnerExists,
    controlAvailable,
    unavailableReason,
    hostedRuntime,
  };
}

export function maintenanceRunnerArgs(
  profile: MaintenanceProfileId,
  options: MaintenanceCommandOptions,
  state = getMaintenanceRunnerState(),
) {
  const apply = options.apply ?? true;
  const baselineCostCapUsd = safeCostCap(options.baselineCostCapUsd);
  const scriptPath =
    state.runnerPath ||
    (state.workerAppDir ? join(state.workerAppDir, "scripts", runnerFile) : `scripts/${runnerFile}`);
  return [
    scriptPath,
    ...maintenanceEnvArgs(state.workerAppDir),
    `--profile=${profile}`,
    `--apply=${apply}`,
    `--baseline-cost-cap-usd=${baselineCostCapUsd}`,
  ];
}

export function maintenanceCommandForDisplay(
  profile: MaintenanceProfileId,
  options: MaintenanceCommandOptions,
  state = getMaintenanceRunnerState(),
) {
  return formatCommand([process.execPath, ...maintenanceRunnerArgs(profile, options, state)]);
}

export function readLatestMaintenanceReport(
  state = getMaintenanceRunnerState(),
): MaintenanceReport | null {
  if (!state.workerAppDir) return null;
  const reportsDir = join(state.workerAppDir, "reports");
  if (!existsSync(reportsDir)) return null;

  const candidates = readdirSync(reportsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("maintenance-"))
    .map((entry) => join(reportsDir, entry.name, "summary.json"))
    .filter((path) => existsSync(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  const path = candidates[0];
  if (!path) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      path,
      started_at: cleanText(parsed.started_at),
      finished_at:
        typeof parsed.finished_at === "string" ? parsed.finished_at : parsed.finished_at === null ? null : undefined,
      status: cleanText(parsed.status),
      profile: cleanText(parsed.profile),
      apply: typeof parsed.apply === "boolean" ? parsed.apply : undefined,
      phases: Array.isArray(parsed.phases)
        ? parsed.phases
            .map((phase) => maintenanceReportPhase(phase))
            .filter((phase): phase is MaintenanceReportPhase => Boolean(phase))
        : [],
    };
  } catch {
    return null;
  }
}

export function formatCommand(parts: string[]) {
  return parts.map(formatCommandPart).join(" ");
}

export function safeCostCap(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_BASELINE_COST_CAP_USD;
  return Math.min(100, Math.round(parsed * 100) / 100);
}

function maintenanceEnvArgs(workerAppDir: string) {
  if (!workerAppDir) return [];
  const explicit = cleanText(process.env.AWARDPING_MAINTENANCE_ENV_FILE);
  if (explicit) return ["--env", explicit];
  if (existsSync(join(workerAppDir, ".env.worker.local"))) return ["--env", ".env.worker.local"];
  if (existsSync(join(workerAppDir, ".env.local"))) return ["--env", ".env.local"];
  return [];
}

function maintenanceReportPhase(value: unknown): MaintenanceReportPhase | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const phase = value as Record<string, unknown>;
  return {
    name: cleanText(phase.name),
    status: cleanText(phase.status),
    started_at: cleanText(phase.started_at),
    finished_at:
      typeof phase.finished_at === "string"
        ? phase.finished_at
        : phase.finished_at === null
          ? null
          : undefined,
    exit_code: typeof phase.exit_code === "number" ? phase.exit_code : null,
    log_path: cleanText(phase.log_path),
  };
}

function defaultLocalWorkerAppDir() {
  return process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "AwardPingWorker", "app")
    : "";
}

function isHostedRuntime() {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.NETLIFY ||
      process.env.K_SERVICE,
  );
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function formatCommandPart(value: string) {
  if (/^[A-Za-z0-9_./:=,-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
