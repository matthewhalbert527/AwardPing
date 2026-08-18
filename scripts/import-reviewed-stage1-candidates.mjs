#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStage1CandidateImportApplyReceipt,
  buildStage1CandidateImportPlan,
  stage1CandidateImportRpcArgs,
  validateStage1CandidateImportApplyProof,
} from "./lib/stage1-reviewed-candidate-import.mjs";
import { loadStage1CandidateImportEvidence } from "./lib/stage1-reviewed-candidate-import-loader.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultArchiveRoot = "D:\\AwardPingVisualSnapshots";

try {
  await main();
} catch (error) {
  console.error(`Stage 1 candidate import failed closed: ${safeError(error)}`);
  console.error("Candidate writes: 0 unless an explicitly confirmed atomic RPC succeeded; source/release/publication mutations: 0; paid API calls: 0");
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const bundlePath = resolve(root, requireArg(args.bundle, "--bundle"));
  if (!existsSync(bundlePath)) throw new Error(`Candidate import bundle does not exist: ${bundlePath}`);
  const bundle = readJson(bundlePath, "candidate import bundle");
  const envPath = resolve(root, String(args.env || defaultEnvFile()));
  const env = {
    ...(existsSync(envPath) ? loadEnvFile(envPath) : {}),
    ...process.env,
  };
  const supabaseUrl = cleanText(env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = cleanText(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }
  const archiveRoot = resolve(String(
    args["archive-dir"] || env.AWARDPING_VISUAL_SNAPSHOT_DIR || defaultArchiveRoot,
  ));
  const now = new Date();
  const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
  const evidence = await loadStage1CandidateImportEvidence({
    supabase,
    bundle,
    archiveRoot,
    now,
  });
  const plan = buildStage1CandidateImportPlan({
    bundle,
    ...evidence,
    now,
  });
  const outputPath = resolve(root, String(args.output || join(
    "reports",
    `stage1-candidate-import-${plan.bundle.cohort.cohort_key}-${fileTimestamp(now.toISOString())}.json`,
  )));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(`Stage 1 candidate import preview: ${outputPath}`);
  console.log(`Candidates: ${plan.candidate_rows.length}`);
  console.log(`Confirmation: ${plan.confirmation_phrase}`);
  console.log("Paid API calls: 0; source/release/reconciliation/publication mutations: 0");

  if (!args.apply) {
    console.log("Preview only. Re-run with --apply and the exact --confirm phrase after review.");
    return;
  }
  const confirmation = requireArg(args.confirm, "--confirm");
  if (confirmation !== plan.confirmation_phrase) {
    throw new Error("--confirm does not exactly match the current verified import plan.");
  }
  const applyResultPath = resolve(root, String(args["apply-result"] || join(
    "reports",
    `stage1-candidate-import-apply-${plan.bundle.cohort.cohort_key}-${fileTimestamp(now.toISOString())}.json`,
  )));
  if (sameLocalPath(applyResultPath, outputPath)) {
    throw new Error("--apply-result must be separate from the preview --output path.");
  }
  if (existsSync(applyResultPath)) {
    throw new Error(`Candidate import apply receipt already exists: ${applyResultPath}`);
  }
  mkdirSync(dirname(applyResultPath), { recursive: true });
  const { data, error } = await supabase.rpc(
    "import_reviewed_stage1_fact_candidates",
    stage1CandidateImportRpcArgs(plan),
  );
  if (error) throw new Error(`Atomic reviewed candidate import failed: ${error.message}`);
  const proof = validateStage1CandidateImportApplyProof(data, plan);
  const receipt = buildStage1CandidateImportApplyReceipt({
    plan,
    proof,
    appliedAt: new Date(),
  });
  writeFileSync(
    applyResultPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  console.log(`Imported candidate rows: ${proof.inserted_count}; existing idempotent rows: ${proof.existing_count}`);
  console.log(`Bundle SHA-256: ${proof.bundle_sha256}`);
  console.log(`Apply receipt: ${applyResultPath}`);
}

function sameLocalPath(left, right) {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function parseArgs(values) {
  const parsed = {};
  const allowed = new Set([
    "bundle",
    "env",
    "archive-dir",
    "output",
    "apply-result",
    "apply",
    "confirm",
    "help",
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected positional argument: ${value}`);
    const [key, ...inline] = value.slice(2).split("=");
    if (!allowed.has(key)) throw new Error(`Unknown option --${key}.`);
    if (["apply", "help"].includes(key)) {
      if (inline.length) throw new Error(`--${key} does not accept a value.`);
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
  if (parsed.confirm && !parsed.apply) {
    throw new Error("--confirm is accepted only with --apply.");
  }
  if (parsed["apply-result"] && !parsed.apply) {
    throw new Error("--apply-result is accepted only with --apply.");
  }
  return parsed;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} JSON ${path}: ${safeError(error)}`);
  }
}

function loadEnvFile(path) {
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function defaultEnvFile() {
  return existsSync(resolve(root, ".env.worker.local"))
    ? ".env.worker.local"
    : ".env.local";
}

function requireArg(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function fileTimestamp(value) {
  return value.replace(/[:.]/g, "-");
}

function safeError(error) {
  return String(error?.message || error || "unknown_error")
    .replace(/(eyJ[a-zA-Z0-9._-]+)/g, "[redacted-token]")
    .replace(/(sb_(?:secret|publishable)_[a-zA-Z0-9_-]+)/g, "[redacted-key]")
    .slice(0, 2_000);
}

function printHelp() {
  console.log(`Usage:
  npm run stage1:import-reviewed -- --bundle=<reviewed.json>

Required:
  --bundle=<path>       Explicit-human candidate drafts with exact immutable
                        local-text quote ranges; one exact Stage 1 cohort.

Options:
  --archive-dir=<path>  Defaults to AWARDPING_VISUAL_SNAPSHOT_DIR, then
                        D:\\AwardPingVisualSnapshots
  --env=<path>          Defaults to .env.worker.local, then .env.local
  --output=<path>       Local preview/confirmation report
  --apply               Call the service-only atomic idempotent insert RPC
  --confirm=<phrase>    Exact phrase printed by the current verified preview
  --apply-result=<path> Separate write-once local apply receipt; defaults under
                        reports/ and never overwrites the preview
  --help                Show help without loading credentials

Safety:
  Preview performs SELECT-only database reads and local immutable-text reads.
  Apply inserts only new pending reviewed fact candidates plus a private
  idempotency ledger. It never changes sources, releases, reconciliation,
  publication state, or legacy candidate rows, and makes zero paid API calls.`);
}
