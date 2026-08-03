#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReviewedStage1ReconciliationDatabase } from "./lib/stage1-reviewed-reconciliation-loader.mjs";
import { buildReviewedStage1ReconciliationPlan } from "./lib/stage1-reviewed-reconciliation.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  await main();
} catch (error) {
  console.error(`Reviewed Stage 1 reconciliation failed closed: ${safeError(error)}`);
  console.error("Paid API calls: 0; ranked candidates accepted: 0; monitoring sources retired: 0");
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const selectionPath = resolve(root, requireArg(args.selection, "--selection"));
  if (!existsSync(selectionPath)) throw new Error(`Selection file does not exist: ${selectionPath}`);
  const selection = readJson(selectionPath, "reviewed selection");
  const apply = boolArg(args.apply, false);
  if (args.confirm && !apply) throw new Error("--confirm is valid only with --apply=true.");
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
  const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
  const first = await loadPlan({ supabase, selection });
  const outputPath = resolve(root, String(args.output || join(
    "reports",
    `stage1-reviewed-reconciliation-${first.selection.cohort.cohort_key}-${fileTimestamp(new Date().toISOString())}.json`,
  )));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(previewDocument(first), null, 2)}\n`, "utf8");

  if (!apply) {
    console.log(`Reviewed Stage 1 reconciliation preview: ${outputPath}`);
    console.log(`Confirmation: ${first.confirmation_phrase}`);
    console.log("Remote mutations: 0; paid API calls: 0; ranked candidates accepted: 0");
    return;
  }
  if (cleanText(args.confirm) !== first.confirmation_phrase) {
    throw new Error("Exact reviewed reconciliation confirmation phrase is required.");
  }

  // A complete second stable read happens immediately before the first remote
  // mutation. Queue creation/claim and the commit RPC then close the remaining
  // races with uniqueness, generation CAS, row locks, and exact state checks.
  const fresh = await loadPlan({ supabase, selection });
  if (fresh.confirmation_sha256 !== first.confirmation_sha256) {
    throw new Error("Reviewed reconciliation evidence changed after preview; generate a new confirmation.");
  }
  const queue = await ensureQueue(supabase, fresh);
  const startedAt = new Date().toISOString();
  const claimed = await claimQueue(supabase, queue, startedAt);
  if (!claimed) {
    throw new Error("Reviewed reconciliation queue changed before its exact claim could be acquired.");
  }

  try {
    const committed = await commitPlan(supabase, fresh, claimed, startedAt);
    if (!committed || committed.status !== "succeeded") {
      throw new Error("Reviewed reconciliation atomic commit did not return succeeded.");
    }
    console.log(`Reviewed Stage 1 reconciliation committed: ${committed.id}`);
    console.log(`Selection SHA-256: ${fresh.selection_sha256}`);
    console.log("Paid API calls: 0; ranked candidates accepted: 0; monitoring sources retired: 0");
  } catch (error) {
    await failOwnedQueue(supabase, claimed, startedAt, safeError(error));
    throw error;
  }
}

async function loadPlan({ supabase, selection }) {
  const now = new Date();
  const database = await loadReviewedStage1ReconciliationDatabase({
    supabase,
    selection,
    now,
  });
  return buildReviewedStage1ReconciliationPlan({ selection, database, now });
}

async function ensureQueue(supabase, plan) {
  if (plan.queue_binding.mode === "existing") return plan.queue_binding;
  const { data, error } = await supabase
    .from("shared_award_reconciliation_queue")
    .insert({
      id: plan.queue_binding.id,
      shared_award_id: plan.commit.shared_award_id,
      reason: "explicit_human_review",
      source_ids: plan.commit.source_ids,
      candidate_ids: plan.commit.candidate_ids,
      status: "pending",
      priority: 1,
      metadata: {
        processor: "reconcile-reviewed-stage1-selection",
        selection_mode: "explicit_human_review",
        selection_sha256: plan.selection_sha256,
        stage1_review_root_schema_version:
          plan.review_binding.stage1_review_root_schema_version,
        stage1_review_root_sha256: plan.review_binding.stage1_review_root_sha256,
        reviewed_contributor_source_ids: plan.commit.source_ids,
        reviewed_candidate_ids: plan.commit.candidate_ids,
        selection_state_sha256: plan.selection_state_sha256,
        expected_award_updated_at: plan.commit.expected_award_updated_at,
        current_public_facts_sha256:
          plan.review_binding.award.current_public_facts_sha256,
        replacement_public_facts_sha256:
          plan.review_binding.award.replacement_public_facts_sha256,
      },
    })
    .select("id,shared_award_id,reason,status,generation,source_ids,candidate_ids,metadata,created_at")
    .maybeSingle();
  if (error || !data) {
    throw new Error(`Create reviewed reconciliation queue failed: ${error?.message || "no row returned"}`);
  }
  if (data.id !== plan.queue_binding.id || data.status !== "pending" || Number(data.generation) !== 0) {
    throw new Error("Created reviewed reconciliation queue does not match its deterministic preview binding.");
  }
  return { ...plan.queue_binding, ...data };
}

async function claimQueue(supabase, queue, startedAt) {
  const { data, error } = await supabase
    .from("shared_award_reconciliation_queue")
    .update({
      status: "processing",
      started_at: startedAt,
      completed_at: null,
      error: null,
    })
    .eq("id", queue.id)
    .eq("status", "pending")
    .eq("generation", queue.generation)
    .select("id,shared_award_id,status,generation,started_at")
    .maybeSingle();
  if (error) throw new Error(`Claim reviewed reconciliation queue failed: ${error.message}`);
  return data || null;
}

async function commitPlan(supabase, plan, queue, startedAt) {
  const commit = plan.commit;
  const { data, error } = await supabase.rpc(
    "commit_reviewed_stage1_reconciliation_publication",
    {
      p_reconciliation_id: queue.id,
      p_shared_award_id: commit.shared_award_id,
      p_expected_started_at: startedAt,
      p_expected_queue_generation: queue.generation,
      p_expected_award_updated_at: commit.expected_award_updated_at,
      p_expected_public_facts: commit.expected_public_facts,
      p_summary: commit.summary,
      p_public_facts: commit.public_facts,
      p_confidence: commit.confidence,
      p_evidence_rows: commit.evidence_rows,
      p_source_ids: commit.source_ids,
      p_candidate_ids: commit.candidate_ids,
      p_generated_candidates: commit.generated_candidates,
      p_candidate_status_updates: commit.candidate_status_updates,
      p_audit_row: commit.audit_row,
      p_review_binding: plan.review_binding,
    },
  );
  if (error) throw new Error(`Atomic reviewed reconciliation failed: ${error.message}`);
  return data || null;
}

async function failOwnedQueue(supabase, queue, startedAt, errorText) {
  try {
    await supabase.rpc("finish_or_requeue_award_reconciliation_claim", {
      p_reconciliation_id: queue.id,
      p_shared_award_id: queue.shared_award_id,
      p_expected_started_at: startedAt,
      p_expected_queue_generation: queue.generation,
      p_terminal_status: "failed",
      p_error: errorText.slice(0, 1_500),
    });
  } catch {
    // The durable processing row remains visible for stale-claim recovery.
  }
}

function previewDocument(plan) {
  return {
    schema_version: plan.schema_version,
    selection_sha256: plan.selection_sha256,
    selection_state_sha256: plan.selection_state_sha256,
    confirmation_payload: plan.confirmation_payload,
    confirmation_sha256: plan.confirmation_sha256,
    confirmation_phrase: plan.confirmation_phrase,
    queue_binding: plan.queue_binding,
    derived_source_ids: plan.commit.source_ids,
    selected_candidate_ids: plan.commit.candidate_ids,
    public_facts: plan.commit.public_facts,
    safety: plan.safety,
  };
}

function parseArgs(values) {
  const parsed = {};
  const allowed = new Set(["selection", "env", "output", "apply", "confirm", "help"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected positional argument: ${value}`);
    const [key, ...inline] = value.slice(2).split("=");
    if (!allowed.has(key)) throw new Error(`Unknown option --${key}.`);
    if (key === "help") {
      parsed.help = true;
      continue;
    }
    if (inline.length) {
      parsed[key] = inline.join("=");
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      if (key === "apply") parsed[key] = "true";
      else throw new Error(`--${key} requires a value.`);
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(String(value))) return true;
  if (/^(0|false|no|off)$/i.test(String(value))) return false;
  throw new Error(`Invalid boolean value: ${value}`);
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
  npm run stage1:reconcile-reviewed -- --selection=<reviewed-selection.json>

Preview is the default and performs SELECT-only database reads plus one local
report write. Apply requires both flags from that exact preview:

  --apply=true
  --confirm="CONFIRM STAGE1 RECONCILIATION <sha256>"

The command loads only explicitly selected candidate IDs and their direct
sources. It never ranks or materializes candidates, retires monitoring sources,
captures pages, requests R2 objects, or calls a paid provider.`);
}
