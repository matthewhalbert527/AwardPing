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
  assertStage1PromotionConfirmation,
  buildStage1ReviewedPromotionPlan,
  promotionRpcArgs,
  resolveStage1PromotionTargets,
  verifyStage1PromotionResult,
} from "./lib/stage1-reviewed-promotion.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  await main();
} catch (error) {
  console.error(`Stage 1 reviewed promotion failed: ${safeError(error)}`);
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const apply = booleanArg(args.apply, false);
  const targetCohortKeys = resolveStage1PromotionTargets({
    cohortKey: args["cohort-key"],
    all: booleanArg(args.all, false),
  });
  const actor = requireArg(args.actor, "--actor");
  const reason = requireArg(args.reason, "--reason");
  const envPath = resolve(root, String(args.env || defaultEnvFile()));
  const env = {
    ...(existsSync(envPath) ? loadEnvFile(envPath) : {}),
    ...process.env,
  };
  const supabaseUrl = cleanText(env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = cleanText(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in the selected environment file or process environment.",
    );
  }

  const manifestDocument = args.manifest
    ? loadJsonFile(resolve(root, String(args.manifest)), "manifest")
    : null;
  const generatedAt = new Date().toISOString();
  const outputPath = resolve(
    root,
    String(
      args.output
      || join(
        "reports",
        `stage1-reviewed-promotion-${targetCohortKeys.length === 25 ? "national-25" : targetCohortKeys[0]}-${fileTimestamp(generatedAt)}.json`,
      ),
    ),
  );

  const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
  const { data: reviewRows, error: previewError } = await supabase.rpc(
    "get_stage1_promotion_review_snapshot",
    { p_cohort_keys: targetCohortKeys },
  );
  if (previewError) {
    throw new Error(`Load reviewed promotion preview: ${safeError(previewError)}`);
  }

  let plan;
  try {
    plan = buildStage1ReviewedPromotionPlan({
      targetCohortKeys,
      reviewRows,
      manifestDocument,
      actor,
      reason,
      policyVersion: args["policy-version"],
    });
  } catch (error) {
    const blockedReport = {
      generated_at: generatedAt,
      mode: apply ? "apply_blocked_before_mutation" : "dry_run_blocked",
      environment_file: relativeToRoot(envPath),
      manifest_file: args.manifest
        ? relativeToRoot(resolve(root, String(args.manifest)))
        : null,
      target_cohort_keys: targetCohortKeys,
      ready_to_apply: false,
      confirmation_hash: null,
      blocker: safeError(error),
      evidence_preview: reviewRows || [],
      proposed_manifest_document: manifestDocument,
      recommended_safe_action:
        "Repair the manifest/evidence blocker shown above, then run another dry-run. Apply is unavailable until a confirmation hash is generated.",
      safety: {
        remote_mutations: 0,
        paid_api_calls: 0,
      },
    };
    writeReport(outputPath, blockedReport);
    if (apply) {
      throw new Error(`${safeError(error)} Blocked preview report: ${outputPath}`);
    }
    console.log(`Stage 1 promotion preview is blocked: ${outputPath}`);
    console.log(`Blocker: ${blockedReport.blocker}`);
    console.log("Remote mutations: 0; paid API calls: 0; confirmation hash: unavailable");
    process.exitCode = 2;
    return;
  }
  const report = {
    generated_at: generatedAt,
    mode: apply ? "apply" : "dry_run",
    environment_file: relativeToRoot(envPath),
    manifest_file: args.manifest
      ? relativeToRoot(resolve(root, String(args.manifest)))
      : null,
    plan,
    apply: {
      requested: apply,
      attempted: false,
      completed: false,
      database_commit_status: "not_attempted",
      confirmation_hash_matched: false,
      promoted_rows: [],
      verification: null,
      post_apply_review_hashes: {},
    },
  };

  if (!apply) {
    writeReport(outputPath, report);
    console.log(`Stage 1 promotion preview: ${outputPath}`);
    console.log(`Target: ${plan.target_mode} (${plan.cohort_keys.length})`);
    console.log(`Confirmation hash: ${plan.confirmation_hash}`);
    console.log("Remote mutations: 0; paid API calls: 0");
    console.log(
      `After reviewing the report, apply with the same arguments plus --apply --confirm-hash=${plan.confirmation_hash}`,
    );
    return;
  }

  try {
    assertStage1PromotionConfirmation(plan, args["confirm-hash"]);
    report.apply.confirmation_hash_matched = true;
    report.apply.attempted = true;
    report.apply.database_commit_status = "unknown";
    const { data: promotedRows, error: promotionError } = await supabase.rpc(
      "apply_stage1_reviewed_promotion",
      promotionRpcArgs(plan),
    );
    if (promotionError) {
      report.apply.database_commit_status = "rolled_back";
      throw new Error(`Apply reviewed promotion: ${safeError(promotionError)}`);
    }
    report.apply.database_commit_status = "committed";

    const { data: effectiveRows, error: effectiveError } = await supabase.rpc(
      "list_stage1_effective_publication",
    );
    if (effectiveError) {
      throw new Error(`Verify effective Stage 1 publication: ${safeError(effectiveError)}`);
    }
    const verification = verifyStage1PromotionResult({
      plan,
      promotedRows,
      effectiveRows,
    });
    const { data: postApplyRows, error: postApplyError } = await supabase.rpc(
      "get_stage1_promotion_review_snapshot",
      { p_cohort_keys: targetCohortKeys },
    );
    if (postApplyError) {
      throw new Error(`Load post-apply audit snapshot: ${safeError(postApplyError)}`);
    }

    report.apply.completed = true;
    report.apply.promoted_rows = promotedRows || [];
    report.apply.verification = verification;
    report.apply.post_apply_review_hashes = Object.fromEntries(
      (postApplyRows || []).map((row) => [row.cohort_key, row.review_hash]),
    );
    writeReport(outputPath, report);
    console.log(`Stage 1 reviewed promotion applied: ${outputPath}`);
    console.log(`Verified cohorts: ${verification.target_count}`);
    console.log(
      verification.public_release_effective
        ? "The exact national 25 release is effective."
        : verification.awaiting_release_acceptance
          ? "All 25 awards are verified but remain private pending the separate release-acceptance gate."
          : verification.single_award_note,
    );
    console.log("Paid API calls: 0");
  } catch (error) {
    report.apply.error = safeError(error);
    report.apply.recommended_safe_action = report.apply.database_commit_status === "committed"
      ? "The database transaction committed. Do not reapply it; read the authoritative Stage 1 status and resolve only the post-commit verification failure."
      : report.apply.database_commit_status === "rolled_back"
        ? "The database transaction rolled back. Repair the named blocker, then generate and review a new dry-run preview."
        : "Commit status is unknown. Do not retry. Read the authoritative Stage 1 status first, then generate a new preview only if no promotion committed.";
    writeReport(outputPath, report);
    throw new Error(`${safeError(error)} Failure report: ${outputPath}`);
  }
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function loadJsonFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} file does not exist: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Read ${label} JSON ${path}: ${safeError(error)}`);
  }
}

function defaultEnvFile() {
  return existsSync(resolve(root, ".env.worker.local"))
    ? ".env.worker.local"
    : ".env.local";
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
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function booleanArg(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (/^(1|true|yes|y)$/i.test(String(value))) return true;
  if (/^(0|false|no|n)$/i.test(String(value))) return false;
  throw new Error(`Invalid boolean argument: ${value}.`);
}

function requireArg(value, label) {
  const normalized = cleanText(value);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function fileTimestamp(value) {
  return value.replace(/[:.]/g, "-");
}

function relativeToRoot(path) {
  const absolute = resolve(path);
  return absolute.startsWith(root) ? absolute.slice(root.length + 1) : absolute;
}

function safeError(error) {
  return String(error?.message || error || "unknown_error")
    .replace(/(eyJ[a-zA-Z0-9._-]+)/g, "[redacted-token]")
    .replace(/(sb_(?:secret|publishable)_[a-zA-Z0-9_-]+)/g, "[redacted-key]")
    .slice(0, 2_000);
}

function printHelp() {
  console.log(`Usage:
  npm run stage1:promote -- --cohort-key=marshall --actor=<operator> --reason=<reason>
  npm run stage1:promote -- --all --actor=<operator> --reason=<reason>

Dry-run is the default and performs no remote mutations or paid API calls. It
writes the evidence/manifests and a confirmation hash to a local JSON report.
After review, repeat the exact command with:
  --apply --confirm-hash=<hash>

Options:
  --manifest=<json>       Proposed manifest document; otherwise current rows are used
  --env=<path>            Defaults to .env.worker.local, then .env.local
  --output=<path>         Local JSON report path
  --policy-version=<ver>  Must equal the current Stage 1 policy version
  --help                  Show this message`);
}
