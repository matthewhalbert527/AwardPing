#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyStage1ReviewedSourceOnboardingPlan,
  buildStage1ReviewedSourceOnboardingPlan,
} from "./lib/stage1-reviewed-source-onboarding-plan.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  await main();
} catch (error) {
  console.error(`Stage 1 reviewed source onboarding failed closed: ${safeError(error)}`);
  console.error("Production writes: 0 unless an exact confirmed atomic enqueue succeeded; paid API calls: 0.");
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const apply = args.apply === true;
  if (apply && !cleanText(args.confirm)) {
    throw new Error("--apply requires --confirm=<exact preview plan SHA-256>.");
  }

  const paths = {
    readiness: resolveInput(args.readiness || "reports/stage1-cohort-readiness-current.json"),
    review1: resolveInput(
      args["review-1"] || "reports/stage1-awards-1-8-official-role-review-2026-07-17.json",
    ),
    review2: resolveInput(
      args["review-2"] || "reports/stage1-official-source-review-09-16-20260717.json",
    ),
    review3: resolveInput(
      args["review-3"] || "reports/stage1-official-source-review-17-25-20260717.json",
    ),
  };
  const outputPath = resolveInput(
    args.output || "reports/stage1-reviewed-source-onboarding-plan.json",
  );
  const plan = buildStage1ReviewedSourceOnboardingPlan({
    readinessReport: readInput(paths.readiness),
    reviewReports: [
      readInput(paths.review1),
      readInput(paths.review2),
      readInput(paths.review3),
    ],
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  console.log(`Stage 1 reviewed source onboarding plan: ${outputPath}`);
  console.log(`Exact awards / roles: ${plan.summary.exact_award_count} / ${plan.summary.accounted_award_role_slot_count}`);
  console.log(`Existing sources (read-only): ${plan.summary.unique_existing_sources}`);
  console.log(`New-page requests: ${plan.summary.new_page_requests} (${plan.summary.new_request_role_links} role links)`);
  console.log(`Collapsed new candidate rows: ${plan.summary.new_page_candidate_rows_collapsed}`);
  console.log(`Plan SHA-256: ${plan.confirmation.plan_sha256}`);
  console.log("Plan build production writes: 0; paid API calls: 0; ranked candidates accepted: 0.");

  if (!apply) {
    console.log(
      `Next: review the plan, then rerun with --apply --confirm=${plan.confirmation.plan_sha256} to enqueue only the new-page requests.`,
    );
    return;
  }

  const envPath = resolveInput(args.env || defaultEnvFile());
  const env = {
    ...(existsSync(envPath) ? loadEnvFile(envPath) : {}),
    ...process.env,
  };
  const supabaseUrl = cleanText(env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = cleanText(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Confirmed apply requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  const result = await applyStage1ReviewedSourceOnboardingPlan({
    supabase: createSupabaseServiceClient(supabaseUrl, serviceRoleKey),
    plan,
    confirmationSha256: args.confirm,
  });
  const resultPath = resolveInput(args["apply-result"] || `${outputPath}.apply-result.json`);
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`Confirmed apply result: ${resultPath}`);
  console.log(`Inserted: ${result.inserted_request_count}; already present: ${result.already_present_request_count}`);
  console.log("Existing source mutations: 0; paid API calls: 0; processing started: false.");
}

function parseArgs(values) {
  const parsed = {};
  const allowed = new Set([
    "readiness",
    "review-1",
    "review-2",
    "review-3",
    "output",
    "apply",
    "confirm",
    "env",
    "apply-result",
    "help",
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected positional argument: ${value}`);
    const [key, ...inline] = value.slice(2).split("=");
    if (!allowed.has(key)) throw new Error(`Unknown option --${key}.`);
    if (key === "help" || key === "apply") {
      if (inline.length && inline.join("=") !== "true") {
        throw new Error(`--${key} is a flag and does not accept ${inline.join("=")}.`);
      }
      parsed[key] = true;
      continue;
    }
    if (inline.length) {
      parsed[key] = inline.join("=");
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`--${key} requires a value.`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function readInput(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${safeError(error)}`);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Cannot parse JSON ${path}: ${safeError(error)}`);
  }
  return {
    source_label: basename(path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    document,
  };
}

function resolveInput(value) {
  return resolve(root, String(value));
}

function defaultEnvFile() {
  return existsSync(join(root, ".env.worker.local"))
    ? ".env.worker.local"
    : ".env.local";
}

function loadEnvFile(path) {
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function safeError(error) {
  return String(error?.message || error || "unknown_error")
    .replace(/(eyJ[a-zA-Z0-9._-]+)/g, "[redacted-token]")
    .replace(/(sb_(?:secret|publishable)_[a-zA-Z0-9_-]+)/g, "[redacted-key]")
    .slice(0, 2_000);
}

function printHelp() {
  console.log(`Usage:
  node scripts/build-stage1-reviewed-source-onboarding-plan.mjs

Preview inputs (defaults shown):
  --readiness=reports/stage1-cohort-readiness-current.json
  --review-1=reports/stage1-awards-1-8-official-role-review-2026-07-17.json
  --review-2=reports/stage1-official-source-review-09-16-20260717.json
  --review-3=reports/stage1-official-source-review-17-25-20260717.json
  --output=reports/stage1-reviewed-source-onboarding-plan.json

Confirmed enqueue:
  --apply --confirm=<exact preview plan SHA-256>
  --env=<path>                  Defaults to .env.worker.local, then .env.local
  --apply-result=<path>         Separate local enqueue receipt

Safety:
  Preview performs local reads and one local report write only. Confirmed apply
  inserts only missing deterministic source_page_requests in one statement.
  Existing sources stay read-only. Enqueue makes no paid calls and starts no
  processing; the separate new-page review lane retains its $5/day cap.
  Every request is historical_import + baseline_only and is bound to one exact
  award ID plus one explicitly human-reviewed official URL.`);
}
