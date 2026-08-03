#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STAGE1_BASELINE_APPROVAL_REVIEWED_AT,
  STAGE1_BASELINE_APPROVAL_STATEMENT,
  STAGE1_BASELINE_EVIDENCE_PACKET_SHA256,
  STAGE1_BASELINE_REQUEST_IDS,
  STAGE1_BASELINE_SOURCE_DISPOSITION_SELECT_COLUMNS,
  STAGE1_BASELINE_STATE_FINGERPRINT_SHA256,
  STAGE1_REVIEWED_SOURCE_ONBOARDING_PLAN_SHA256,
  assertStage1BaselineSourceDispositionConfirmation,
  buildStage1BaselineSourceDispositionPlan,
  stage1BaselinePlannedAcquisitionId,
  stage1BaselinePlannedSourceId,
} from "./lib/stage1-baseline-source-disposition.mjs";
import {
  closeSupabaseServiceTransport,
  createSupabaseServiceClient,
} from "./supabase-service-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultReviewPath = "reports/stage1-11-source-disposition-review-2026-08-03.json";
const defaultArchiveRoot = "D:\\AwardPingVisualSnapshots";
let transportOpened = false;

try {
  await main();
} catch (error) {
  console.error(`Stage 1 baseline-source disposition failed closed: ${safeError(error)}`);
  console.error(
    "Database writes: 0 unless the explicitly confirmed atomic disposition RPC succeeded; paid API calls: 0.",
  );
  process.exitCode = 1;
} finally {
  if (transportOpened) {
    try {
      await closeSupabaseServiceTransport();
    } catch {
      // A completed RPC or preview failure must retain its original outcome.
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.apply) {
    await applyReviewedPlan(args);
    return;
  }
  await buildPreview(args);
}

async function buildPreview(args) {
  const reviewPath = resolve(root, String(args.review || defaultReviewPath));
  const reviewRoot = readJson(reviewPath, "human source-disposition review");
  assertReviewRoot(reviewRoot);
  const packetPath = resolveReviewedPacketPath(reviewPath, reviewRoot, args.packet);
  const packetBytes = readFileSync(packetPath);
  const archiveRoot = resolve(String(
    args["archive-dir"] || loadOptionalEnvironment(args).AWARDPING_VISUAL_SNAPSHOT_DIR
      || defaultArchiveRoot,
  ));
  const env = loadRequiredEnvironment(args);
  const supabase = serviceClient(env);

  const freshRows = (await selectExactRows(
    supabase
      .from("source_page_requests")
      .select(STAGE1_BASELINE_SOURCE_DISPOSITION_SELECT_COLUMNS.source_page_requests)
      .in("id", STAGE1_BASELINE_REQUEST_IDS),
    "source_page_requests",
    11,
  )).map((row) => ({ ...row, updated_at: canonicalDatabaseTimestamp(row.updated_at) }));
  const freshById = exactRequestMap(freshRows, "source_page_requests", "id");
  const awardIds = [...new Set(freshRows.map((row) => row.matched_shared_award_id))];
  const existingSources = (await selectRows(
    supabase
      .from("shared_award_sources")
      .select(STAGE1_BASELINE_SOURCE_DISPOSITION_SELECT_COLUMNS.shared_award_sources)
      .in("shared_award_id", awardIds),
    "shared_award_sources",
  )).map((row) => ({
    ...row,
    updated_at: canonicalDatabaseTimestamp(row.updated_at),
  }));
  const sourceBindings = buildSourceBindings(reviewRoot.decisions, freshById, existingSources);
  const approvedSourceIds = sourceBindings
    .map((binding) => binding.source_id)
    .filter(Boolean);
  const plannedAcquisitionIds = reviewRoot.decisions
    .filter((decision) => decision.decision === "approve_baseline_only")
    .map((decision) => stage1BaselinePlannedAcquisitionId(decision.request_id));
  const [acquisitionsBySource, acquisitionsById] = await Promise.all([
    selectRows(
      supabase
        .from("shared_award_source_acquisitions")
        .select(STAGE1_BASELINE_SOURCE_DISPOSITION_SELECT_COLUMNS.shared_award_source_acquisitions)
        .in("shared_award_source_id", approvedSourceIds),
      "shared_award_source_acquisitions by source",
    ),
    selectRows(
      supabase
        .from("shared_award_source_acquisitions")
        .select(STAGE1_BASELINE_SOURCE_DISPOSITION_SELECT_COLUMNS.shared_award_source_acquisitions)
        .in("id", plannedAcquisitionIds),
      "shared_award_source_acquisitions by id",
    ),
  ]);
  if (acquisitionsBySource.length || acquisitionsById.length) {
    throw new Error("A reviewed source or deterministic acquisition identity already has acquisition state.");
  }

  const retainedEvidence = STAGE1_BASELINE_REQUEST_IDS.map((requestId) => {
    const row = freshById.get(requestId);
    return {
      request_id: requestId,
      bytes: readRetainedTextBytes(archiveRoot, row),
    };
  });
  const decisions = buildDecisionInputs(reviewRoot.decisions, freshById, retainedEvidence);
  const acquisitionBindings = reviewRoot.decisions.map((decision) => ({
    request_id: decision.request_id,
    source_acquisition_id: decision.decision === "approve_baseline_only"
      ? stage1BaselinePlannedAcquisitionId(decision.request_id)
      : null,
    expected_existing_acquisition_count: 0,
    expected_existing_acquisition_id: null,
  }));
  const rowsObservedAt = new Date().toISOString();
  const plan = buildStage1BaselineSourceDispositionPlan({
    packetBytes,
    packetSha256: reviewRoot.evidence_packet.sha256,
    stateFingerprintSha256: reviewRoot.evidence_packet.production_state_fingerprint_sha256,
    onboardingPlanSha256: STAGE1_REVIEWED_SOURCE_ONBOARDING_PLAN_SHA256,
    operatorStatement: reviewRoot.review.operator_statement,
    reviewedAt: reviewRoot.review.reviewed_at,
    rowsObservedAt,
    builtAt: rowsObservedAt,
    decisions,
    freshRows,
    retainedEvidence,
    sourceBindings,
    acquisitionBindings,
  });
  const outputPath = resolve(root, String(args.output || join(
    "reports",
    `stage1-baseline-source-disposition-preview-${fileTimestamp(rowsObservedAt)}.json`,
  )));
  writeJsonExclusive(outputPath, plan);

  console.log(`Stage 1 baseline-source disposition preview: ${outputPath}`);
  console.log("Outcome: items 1–6 and 8–11 approved baseline-only; item 7 Luce funding quarantined.");
  console.log(`Plan SHA-256: ${plan.confirmation.plan_sha256}`);
  console.log(`Exact confirmation: ${plan.confirmation.exact_confirmation_phrase}`);
  console.log(
    `Apply within five minutes: npm run stage1:apply-baseline-sources -- --apply --plan="${outputPath}" --confirm=${plan.confirmation.plan_sha256}`,
  );
  console.log("Database writes: 0; paid API calls: 0; public/downstream authority: 0.");
}

async function applyReviewedPlan(args) {
  const planPath = resolve(root, requireArg(args.plan, "--plan"));
  const plan = readJson(planPath, "baseline-source disposition preview plan");
  const confirmation = requireArg(args.confirm, "--confirm");
  const exactPhrase = confirmation === plan?.confirmation?.plan_sha256
    ? plan.confirmation.exact_confirmation_phrase
    : confirmation;
  const verified = assertStage1BaselineSourceDispositionConfirmation(
    plan,
    exactPhrase,
    { now: new Date().toISOString() },
  );
  const env = loadRequiredEnvironment(args);
  const supabase = serviceClient(env);
  const { data, error } = await supabase.rpc("apply_reviewed_stage1_source_dispositions", {
    p_binding: verified,
    p_confirmation_sha256: verified.confirmation.plan_sha256,
  });
  if (error) throw new Error(`Atomic Stage 1 source disposition failed: ${error.message}`);
  const receipt = validateApplyReceipt(data, verified);
  if (args["apply-result"]) {
    const receiptPath = resolve(root, String(args["apply-result"]));
    writeJsonExclusive(receiptPath, receipt);
    console.log(`Local apply receipt: ${receiptPath}`);
  }
  console.log(`Atomic disposition applied: ${receipt.approved_baseline_only} approved baseline-only; ${receipt.kept_quarantined} quarantined.`);
  console.log(`Confirmation SHA-256: ${receipt.confirmation_sha256}`);
  console.log("Paid API calls: 0; public fact writes: 0; first-observation notifications: 0.");
}

function assertReviewRoot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The human source-disposition review must be an object.");
  }
  if (value.schema_version !== "awardping.stage1.source-disposition-human-review.v1"
      || value.policy_version !== "stage1-baseline-source-disposition-v1"
      || value.evidence_packet?.sha256 !== STAGE1_BASELINE_EVIDENCE_PACKET_SHA256
      || value.evidence_packet?.production_state_fingerprint_sha256
        !== STAGE1_BASELINE_STATE_FINGERPRINT_SHA256
      || value.review?.operator_statement !== STAGE1_BASELINE_APPROVAL_STATEMENT
      || value.review?.reviewed_at !== STAGE1_BASELINE_APPROVAL_REVIEWED_AT
      || value.review?.paid_api_calls_authorized !== 0
      || value.safety_contract?.approved_count !== 10
      || value.safety_contract?.quarantined_count !== 1
      || value.safety_contract?.exact_item_count !== 11
      || !Array.isArray(value.decisions) || value.decisions.length !== 11) {
    throw new Error("The review is not the exact approved 10+1 Stage 1 source disposition.");
  }
  const seen = new Set();
  value.decisions.forEach((decision, index) => {
    const expectedDecision = index === 6 ? "keep_quarantined" : "approve_baseline_only";
    if (decision.item_number !== index + 1
        || decision.request_id !== STAGE1_BASELINE_REQUEST_IDS[index]
        || decision.decision !== expectedDecision
        || seen.has(decision.request_id)) {
      throw new Error("The review decisions are not the exact ordered 10+1 request set.");
    }
    seen.add(decision.request_id);
  });
}

function resolveReviewedPacketPath(reviewPath, reviewRoot, override) {
  const reviewed = resolve(root, requireArg(reviewRoot.evidence_packet?.path, "review packet path"));
  if (override) {
    const supplied = resolve(root, String(override));
    if (!sameLocalPath(supplied, reviewed)) {
      throw new Error("--packet must identify the exact packet bound by the human review.");
    }
  }
  if (!existsSync(reviewed)) {
    throw new Error(`Reviewed evidence packet does not exist: ${reviewed}`);
  }
  if (!isInside(reviewed, root)) {
    throw new Error(`Reviewed evidence packet escapes the workspace: ${reviewPath}`);
  }
  return reviewed;
}

function buildDecisionInputs(reviewDecisions, freshById, retainedEvidence) {
  const evidenceById = new Map(retainedEvidence.map((item) => [item.request_id, item.bytes]));
  return reviewDecisions.map((decision) => {
    const row = freshById.get(decision.request_id);
    const text = retainedSemanticText(evidenceById.get(decision.request_id));
    const exactQuotes = decision.evidence_spans.map((span) => ({
      start: span.start,
      end: span.end,
      text: text.slice(span.start, span.end),
    }));
    return {
      request_id: decision.request_id,
      decision: decision.decision,
      reviewed_roles: decision.reviewed_roles,
      exact_quotes: exactQuotes,
      source_title: decision.source_title,
      effective_source_classification: {
        status: decision.decision === "approve_baseline_only" ? "accepted" : "needs_review",
        source_relevance: row.ai_review?.source_relevance,
        cycle_relevance: decision.effective_cycle_relevance,
        officialness: row.ai_review?.officialness,
        confidence: row.ai_review?.confidence,
        page_type: decision.source_page_type,
        facts: {
          description: null,
          deadline: null,
          amount: null,
          eligibility: [],
          application_materials: [],
          important_dates: [],
        },
      },
    };
  });
}

function buildSourceBindings(reviewDecisions, freshById, existingSources) {
  return reviewDecisions.map((decision) => {
    const row = freshById.get(decision.request_id);
    const matches = existingSources.filter((source) => (
      source.shared_award_id === row.matched_shared_award_id
      && normalizedUrlKey(source.url) === normalizedUrlKey(row.normalized_url)
    ));
    const reviewedExistingId = decision.expected_existing_source?.id || null;
    if (matches.length !== (reviewedExistingId ? 1 : 0)
        || (reviewedExistingId && matches[0]?.id !== reviewedExistingId)) {
      throw new Error(`Source identity state changed for reviewed item ${decision.item_number}.`);
    }
    if (decision.decision === "keep_quarantined") {
      return {
        request_id: decision.request_id,
        source_id: null,
        normalized_url: row.normalized_url,
        normalized_collision_count: 0,
        expected_existing_source_id: null,
        expected_existing_admin_review_status: null,
        expected_existing_updated_at: null,
        existing_source: null,
      };
    }
    const existing = matches[0] || null;
    return {
      request_id: decision.request_id,
      source_id: existing?.id || stage1BaselinePlannedSourceId(decision.request_id),
      normalized_url: row.normalized_url,
      normalized_collision_count: existing ? 1 : 0,
      expected_existing_source_id: existing?.id || null,
      expected_existing_admin_review_status: existing?.admin_review_status || null,
      expected_existing_updated_at: existing?.updated_at || null,
      existing_source: existing,
    };
  });
}

function readRetainedTextBytes(archiveRoot, row) {
  const manifest = row.capture_metadata?.retained_artifact;
  const fileHash = cleanText(manifest?.file_hash);
  const requestId = cleanText(row.id);
  const relativeTextPath = cleanText(manifest?.local_cache?.text) || join(
    "intake-artifacts", "requests", requestId, "sha256", fileHash, "text.txt",
  );
  const textPath = isAbsolute(relativeTextPath)
    ? resolve(relativeTextPath)
    : resolve(archiveRoot, relativeTextPath);
  if (!isInside(textPath, archiveRoot)) {
    throw new Error(`Retained text path escapes the archive root for ${requestId}.`);
  }
  if (!existsSync(textPath)) {
    throw new Error(`Retained text is missing for ${requestId}: ${textPath}`);
  }
  return readFileSync(textPath);
}

function retainedSemanticText(bytes) {
  return new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .replace(/\u0000/g, "")
    .trim();
}

function validateApplyReceipt(value, plan) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schema_version !== "awardping.stage1.source-disposition-apply-receipt.v1"
      || value.status !== "applied"
      || value.confirmation_sha256 !== plan.confirmation.plan_sha256
      || value.evidence_packet_sha256 !== STAGE1_BASELINE_EVIDENCE_PACKET_SHA256
      || value.approved_baseline_only !== 10
      || value.kept_quarantined !== 1
      || !Array.isArray(value.items) || value.items.length !== 11
      || ["paid_api_calls", "public_fact_writes", "fact_candidates",
        "reconciliation_requests", "first_observation_notifications"]
        .some((key) => value[key] !== 0)) {
    throw new Error("The atomic RPC returned an invalid or broadened apply receipt.");
  }
  return value;
}

async function selectExactRows(query, label, count) {
  const rows = await selectRows(query, label);
  if (rows.length !== count) throw new Error(`${label} returned ${rows.length}; expected ${count}.`);
  return rows;
}

async function selectRows(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`Cannot read ${label}: ${error.message}`);
  if (!Array.isArray(data)) throw new Error(`${label} did not return rows.`);
  return data;
}

function exactRequestMap(rows, label, key) {
  const map = new Map();
  for (const row of rows) {
    const id = row?.[key];
    if (map.has(id)) throw new Error(`${label} returned duplicate request ${id}.`);
    map.set(id, row);
  }
  if (STAGE1_BASELINE_REQUEST_IDS.some((id) => !map.has(id))) {
    throw new Error(`${label} did not return the exact reviewed request set.`);
  }
  return map;
}

function serviceClient(env) {
  transportOpened = true;
  return createSupabaseServiceClient(
    requireArg(env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    requireArg(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"),
  );
}

function loadRequiredEnvironment(args) {
  const env = loadOptionalEnvironment(args);
  requireArg(env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL");
  requireArg(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
  return env;
}

function loadOptionalEnvironment(args) {
  const envPath = resolve(root, String(args.env || defaultEnvFile()));
  return {
    ...(existsSync(envPath) ? loadEnvFile(envPath) : {}),
    ...process.env,
  };
}

function loadEnvFile(path) {
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function defaultEnvFile() {
  return existsSync(resolve(root, ".env.worker.local"))
    ? ".env.worker.local"
    : ".env.local";
}

function parseArgs(values) {
  const parsed = {};
  const allowed = new Set([
    "review", "packet", "archive-dir", "env", "output", "apply", "plan",
    "confirm", "apply-result", "help",
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
  if (parsed.apply) {
    requireArg(parsed.plan, "--plan");
    requireArg(parsed.confirm, "--confirm");
    if (parsed.output || parsed.review || parsed.packet || parsed["archive-dir"]) {
      throw new Error("Apply accepts only a previously reviewed --plan; rebuild preview separately.");
    }
  } else if (parsed.plan || parsed.confirm || parsed["apply-result"]) {
    throw new Error("--plan, --confirm, and --apply-result are accepted only with --apply.");
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

function writeJsonExclusive(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function normalizedUrlKey(value) {
  const url = new URL(requireArg(value, "source URL"));
  url.hash = "";
  return url.toString().replace(/\/$/, "").toLowerCase();
}

function canonicalDatabaseTimestamp(value) {
  const parsed = Date.parse(requireArg(value, "database timestamp"));
  if (!Number.isFinite(parsed)) throw new Error("A database timestamp is invalid.");
  return new Date(parsed).toISOString();
}

function isInside(path, directory) {
  const child = resolve(path);
  const parent = resolve(directory);
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sameLocalPath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function requireArg(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
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
  npm run stage1:apply-baseline-sources
  npm run stage1:apply-baseline-sources -- --apply --plan=<preview.json> --confirm=<sha-or-exact-phrase>

Preview options:
  --review=<path>       Exact human 11-source review JSON
  --packet=<path>       Optional assertion of the review-bound packet path
  --archive-dir=<path>  Local immutable intake cache; defaults to worker config
  --env=<path>          Defaults to .env.worker.local, then .env.local
  --output=<path>       Write-once local preview plan

Apply options:
  --apply               Invoke the single atomic 10+1 disposition RPC
  --plan=<path>         Exact previously generated preview plan (required)
  --confirm=<value>     Exact plan SHA-256 or exact confirmation phrase
  --apply-result=<path> Optional write-once local copy of the durable RPC receipt

Safety:
  Preview performs SELECT-only database reads, immutable local evidence reads,
  and one local preview write. Apply performs no SELECT or paid-provider work;
  after local verification it makes exactly one atomic RPC call. The RPC grants
  monitoring only, keeps all approved sources held for exact visual baseline
  activation, and leaves Luce funding quarantined.`);
}
