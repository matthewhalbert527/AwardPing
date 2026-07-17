#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");

export const downstreamLaneDefinitions = Object.freeze({
  new_page_review: {
    script: "scripts/process-new-page-review-lane.mjs",
    args: [],
  },
  changed_page_review: {
    script: "scripts/process-visual-review-batch.mjs",
    args: [
      "--limit=100",
      "--max-requests-per-batch=100",
      "--inline-threshold=100",
      "--poll=true",
      "--submit=true",
      "--apply=true",
      "--paid-lane=changed_page_review",
    ],
  },
  feedback_promotion: {
    script: "scripts/process-monitoring-feedback-promotions.mjs",
    args: ["--apply=true"],
  },
  suppression: {
    script: "scripts/cleanup-change-event-noise.mjs",
    args: [
      "--limit=1000",
      "--batch-size=250",
      "--suppression-source=scheduled-independent-policy-sweep",
      "--apply=true",
    ],
  },
  reconciliation: {
    script: "scripts/reconcile-impacted-award-pages.mjs",
    args: [
      "--limit=250",
      "--only-pending=true",
      "--only-failed=false",
      "--dry-run=false",
      "--apply=true",
      "--include-warnings=true",
    ],
  },
  page_audit: {
    // This is intentionally deterministic. Gemini page-audit submission is not
    // a permanent paid lane and must never be reintroduced here.
    script: "scripts/evaluate-public-page-audit-canaries.mjs",
    args: ["--all=true", "--apply=true", "--fail-on-critical=false"],
  },
  manual_quarantine: {
    script: "scripts/sync-manual-quarantine-registry.mjs",
    args: [],
  },
  nightly_report: {
    script: "scripts/report-visual-nightly.mjs",
    args: ["--write=true"],
    includeEnv: false,
  },
});

export function normalizeDownstreamLaneKey(value) {
  return String(value || "").trim().toLowerCase().replaceAll("-", "_");
}

export function commandForDownstreamLane(laneKey, { envFile = ".env.worker.local", timeBudgetMs } = {}) {
  const normalized = normalizeDownstreamLaneKey(laneKey);
  const definition = downstreamLaneDefinitions[normalized];
  if (!definition) throw new Error(`Unknown downstream lane: ${laneKey || "(missing)"}`);
  const args = [resolve(root, definition.script)];
  // Use the inline form because a few of the older deterministic workers only
  // accept --key=value arguments. Keeping one canonical form prevents a lane
  // from silently falling back to .env.local on the installed worker.
  if (definition.includeEnv !== false) args.push(`--env=${envFile}`);
  if (normalized === "nightly_report") args.push("--reports-dir", resolve(root, "reports"));
  if (normalized === "new_page_review" && Number.isFinite(Number(timeBudgetMs))) {
    args.push(`--time-budget-ms=${Math.max(1_000, Math.floor(Number(timeBudgetMs) - 15_000))}`);
  }
  args.push(...definition.args);
  return { laneKey: normalized, command: process.execPath, args };
}

export function laneClaimRpcParameters({ laneKey, workerSource, workerRunId = null, metadata = {} }) {
  return {
    p_lane_key: laneKey,
    p_worker_source: workerSource,
    p_worker_run_id: workerRunId,
    p_metadata: metadata,
  };
}

export function laneCompletionRpcParameters({
  laneKey,
  runId,
  claimToken,
  succeeded,
  result,
  error = null,
}) {
  return {
    p_lane_key: laneKey,
    p_run_id: runId,
    p_claim_token: claimToken,
    p_succeeded: succeeded,
    p_result: result,
    p_error: error,
  };
}

export function laneExecutionFailureReason({ result, heartbeatError = null, timeBudgetMs = null }) {
  if (heartbeatError) return `lane_lease_lost:${cleanText(heartbeatError.message) || "heartbeat_failed"}`;
  if (result?.timedOut) return `lane_timed_out_after_${positiveInt(timeBudgetMs, 1)}ms`;
  if (result?.aborted) return `lane_aborted:${cleanText(result.error) || "execution_aborted"}`;
  if (cleanText(result?.error)) return `lane_child_error:${cleanText(result.error)}`;
  if (Number.isInteger(result?.exitCode) && result.exitCode !== 0) {
    return `child_exit_code_${result.exitCode}`;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const laneKey = normalizeDownstreamLaneKey(args.lane);
  const definition = downstreamLaneDefinitions[laneKey];
  if (!definition) {
    console.error(`LANE_RUNNER_INVALID lane=${args.lane || "missing"}`);
    process.exitCode = 2;
    return;
  }

  const envArg = String(args.env || ".env.worker.local");
  const envPath = resolve(root, envArg);
  const env = { ...loadEnvFile(envPath), ...process.env };
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  const requestedTimeBudgetMs = positiveInt(args["time-budget-ms"], 10 * 60_000);
  const workerId = cleanText(args["worker-id"]) || `${hostname()}:${process.pid}:${randomUUID()}`;
  const workerRevision = cleanText(env.AWARDPING_WORKER_REVISION || env.VERCEL_GIT_COMMIT_SHA) || "local";
  const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
  const claim = await rpcOne(
    supabase,
    "claim_monitoring_downstream_lane",
    laneClaimRpcParameters({
      laneKey,
      workerSource: workerId,
      metadata: { worker_revision: workerRevision, requested_time_budget_ms: requestedTimeBudgetMs },
    }),
  );
  if (!Boolean(claim?.claimed)) {
    console.log(
      `LANE_RUNNER_SKIPPED lane=${laneKey} reason=${cleanText(claim?.reason) || "lease_unavailable"} next_retry_at=${cleanText(claim?.next_retry_at) || "none"}`,
    );
    return;
  }

  const leaseToken = cleanText(claim.claim_token);
  const laneRunId = cleanText(claim.run_id);
  if (!leaseToken) throw new Error(`Lane ${laneKey} was acquired without a lease token.`);
  if (!laneRunId) throw new Error(`Lane ${laneKey} was acquired without a run id.`);
  const policyTimeoutMs = positiveInt(claim.timeout_seconds, 0) * 1_000;
  const timeBudgetMs = policyTimeoutMs > 0
    ? Math.min(requestedTimeBudgetMs, Math.max(1_000, policyTimeoutMs - 15_000))
    : requestedTimeBudgetMs;
  const startedAt = new Date().toISOString();
  const command = commandForDownstreamLane(laneKey, { envFile: envArg, timeBudgetMs });
  console.log(`LANE_RUNNER_START lane=${laneKey} worker=${workerId} started=${startedAt}`);

  let heartbeatError = null;
  const executionAbort = new AbortController();
  const abortForHeartbeat = (cause) => {
    if (heartbeatError) return;
    heartbeatError = cause instanceof Error ? cause : new Error(String(cause));
    executionAbort.abort(heartbeatError);
  };
  const heartbeatInFlight = new Set();
  const heartbeat = setInterval(() => {
    const request = supabase
      .rpc("heartbeat_monitoring_downstream_lane", {
        p_lane_key: laneKey,
        p_run_id: laneRunId,
        p_claim_token: leaseToken,
        p_metadata: { worker_revision: workerRevision },
      })
      .then(({ data, error }) => {
        if (error) {
          abortForHeartbeat(new Error(`Lane heartbeat RPC failed: ${error.message}`));
          return;
        }
        const heartbeatStatus = Array.isArray(data) ? data[0] || null : data;
        if (heartbeatStatus?.heartbeat !== true) {
          abortForHeartbeat(new Error(
            `Lane heartbeat was rejected: ${cleanText(heartbeatStatus?.reason) || "lease_not_current"}`,
          ));
        }
      })
      .catch((error) => abortForHeartbeat(error))
      .finally(() => heartbeatInFlight.delete(request));
    heartbeatInFlight.add(request);
  }, 30_000);
  heartbeat.unref();

  let result;
  try {
    result = await runChild(command, timeBudgetMs, { signal: executionAbort.signal });
  } finally {
    clearInterval(heartbeat);
  }
  await Promise.allSettled([...heartbeatInFlight]);

  const succeeded = result.exitCode === 0 && !result.timedOut && !result.aborted && !heartbeatError;
  const status = result.timedOut
    ? "timed_out"
    : heartbeatError
      ? "lease_lost"
      : succeeded
        ? "succeeded"
        : "failed";
  const failureReason = laneExecutionFailureReason({ result, heartbeatError, timeBudgetMs });
  const completion = await rpcOne(
    supabase,
    "complete_monitoring_downstream_lane",
    laneCompletionRpcParameters({
      laneKey,
      runId: laneRunId,
      claimToken: leaseToken,
      succeeded,
      result: {
        worker_id: workerId,
        worker_revision: workerRevision,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        timed_out: result.timedOut,
        aborted: result.aborted,
        heartbeat_error: heartbeatError?.message || null,
        policy_timeout_seconds: policyTimeoutMs > 0 ? policyTimeoutMs / 1_000 : null,
        effective_time_budget_ms: timeBudgetMs,
        command: [command.command, ...command.args],
        status,
        exit_code: result.exitCode,
      },
      error: failureReason,
    }),
  );
  if (completion && completion.completed === false) {
    throw new Error(`Lane ${laneKey} completion was rejected because its lease was no longer current.`);
  }

  console.log(`LANE_RUNNER_EXIT lane=${laneKey} status=${status} exit_code=${result.exitCode}`);
  if (!succeeded) process.exitCode = result.exitCode || 1;
}

function runChild({ command, args }, timeBudgetMs, { signal } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    let aborted = false;
    let error = null;
    let forceTimer = null;
    const terminate = (terminationSignal = "SIGTERM") => {
      terminateChildTree(child, terminationSignal);
      if (!forceTimer) {
        forceTimer = setTimeout(() => terminateChildTree(child, "SIGKILL"), 5_000);
        forceTimer.unref();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
    }, timeBudgetMs);
    timer.unref();
    const abortHandler = () => {
      aborted = true;
      const reason = signal?.reason;
      error = reason instanceof Error
        ? reason.message
        : cleanText(reason) || "Lane execution aborted because its lease could not be maintained.";
      terminate("SIGTERM");
    };
    if (signal?.aborted) abortHandler();
    else signal?.addEventListener("abort", abortHandler, { once: true });
    child.once("error", (cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      executionSignalCleanup();
      resolvePromise({
        exitCode: Number.isInteger(code) ? code : 1,
        signal: signal || null,
        timedOut,
        aborted,
        error,
      });
    });

    function executionSignalCleanup() {
      signal?.removeEventListener("abort", abortHandler);
    }
  });
}

function terminateChildTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited between the timeout and termination attempt.
    }
  }
}

async function rpcOne(supabase, name, params) {
  const { data, error } = await supabase.rpc(name, params);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return Array.isArray(data) ? data[0] || null : data;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
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
    const pair = value.slice(2);
    const equals = pair.indexOf("=");
    if (equals >= 0) parsed[pair.slice(0, equals)] = pair.slice(equals + 1);
    else if (values[index + 1] && !values[index + 1].startsWith("--")) parsed[pair] = values[++index];
    else parsed[pair] = true;
  }
  return parsed;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

if (Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
