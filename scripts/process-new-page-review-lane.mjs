#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

export function newPageReviewLaneSteps({
  envFile = ".env.worker.local",
  sourceTimeBudgetMs = 300_000,
} = {}) {
  return [
    {
      key: "source_intake",
      script: "scripts/process-source-intake-requests.mjs",
      args: [
        `--env=${envFile}`,
        "--limit=25",
        "--gemini-api-mode=batch",
        "--max-requests-per-batch=100",
        "--poll-batch-limit=5",
        "--request-timeout-ms=30000",
        "--status=pending,queued",
        "--apply=true",
        `--time-budget-ms=${Math.max(1_000, sourceTimeBudgetMs)}`,
      ],
    },
    {
      key: "initial_official_document_review",
      script: "scripts/process-visual-review-batch.mjs",
      args: [
        `--env=${envFile}`,
        "--paid-lane=new_page_review",
        "--limit=100",
        "--max-requests-per-batch=100",
        "--inline-threshold=100",
        "--poll=true",
        "--submit=true",
        "--apply=true",
      ],
    },
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = String(args.env || ".env.worker.local");
  const totalBudgetMs = positiveInt(args["time-budget-ms"], 9 * 60_000);
  const startedAt = Date.now();
  const sourceBudgetMs = Math.max(30_000, Math.floor(totalBudgetMs * 0.55));
  const steps = newPageReviewLaneSteps({
    envFile,
    sourceTimeBudgetMs: Math.max(1_000, sourceBudgetMs - 5_000),
  });
  const failures = [];

  for (const [index, step] of steps.entries()) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = totalBudgetMs - elapsedMs;
    const stepBudgetMs = index === 0
      ? Math.min(sourceBudgetMs, remainingMs)
      : remainingMs;
    if (stepBudgetMs < 5_000) {
      failures.push({ key: step.key, reason: "lane_time_budget_exhausted" });
      console.error(
        `NEW_PAGE_REVIEW_STEP_SKIPPED step=${step.key} reason=lane_time_budget_exhausted`,
      );
      continue;
    }

    console.log(
      `NEW_PAGE_REVIEW_STEP_START step=${step.key} budget_ms=${stepBudgetMs}`,
    );
    const result = spawnSync(
      process.execPath,
      [resolve(root, step.script), ...step.args],
      {
        cwd: root,
        env: process.env,
        stdio: "inherit",
        timeout: stepBudgetMs,
        windowsHide: true,
      },
    );
    const exitCode = Number.isInteger(result.status) ? result.status : 1;
    const reason = result.error?.code === "ETIMEDOUT"
      ? "step_timed_out"
      : result.error?.message || (exitCode === 0 ? null : `exit_${exitCode}`);
    console.log(
      `NEW_PAGE_REVIEW_STEP_EXIT step=${step.key} exit_code=${exitCode} reason=${reason || "none"}`,
    );
    if (reason) failures.push({ key: step.key, reason });
  }

  if (failures.length) {
    console.error(`NEW_PAGE_REVIEW_LANE_FAILED ${JSON.stringify(failures)}`);
    process.exitCode = 1;
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const pair = value.slice(2);
    const equals = pair.indexOf("=");
    if (equals >= 0) parsed[pair.slice(0, equals)] = pair.slice(equals + 1);
    else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[pair] = values[++index];
    } else parsed[pair] = true;
  }
  return parsed;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

if (Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
