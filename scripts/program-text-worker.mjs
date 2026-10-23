#!/usr/bin/env node
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { createSupabaseServiceClient, closeSupabaseServiceTransport } from "./supabase-service-client.mjs";
import { monitorProgramTextSource, finalizeProgramTextReview } from "./lib/program-text-monitor.mjs";
import { retainProgramTextCapture, uploadProgramTextCapture, loadProgramTextCapture, validateProgramTextReference } from "./lib/program-text-storage.mjs";
import { createProgramTextRepository, programTextCandidateWork } from "./lib/program-text-repository.mjs";
import { submitProgramTextBatch, pollProgramTextBatch } from "./lib/program-text-provider.mjs";

const root = resolve(import.meta.dirname, "..");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const modes = new Set(["plan", "collect", "review", "report", "new_page_review", "legacy_hold"]);
export function parseProgramTextArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error("Expected named worker argument");
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match || Object.hasOwn(args, match[1])) throw new Error("Invalid or duplicate worker argument");
    args[match[1]] = match[2] ?? (argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : argv[++i]);
  }
  const allowed = new Set(["mode", "env", "config", "apply", "pilot", "source-id", "cohort", "shard-count", "shard-index", "limit", "domain-delay-ms", "run-trigger"]);
  if (Object.keys(args).some(k => !allowed.has(k)) || !modes.has(args.mode || "plan")) throw new Error("Unknown text worker option");
  for (const key of ["apply", "pilot"]) if (args[key] !== undefined && !["true", "false"].includes(args[key])) throw new Error("Invalid worker boolean");
  const shardCount = Number(args["shard-count"] || 1), shardIndex = Number(args["shard-index"] || 0);
  const limit = Number(args.limit || 50000), delay = Number(args["domain-delay-ms"] || 1500);
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > 32 || !Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount ||
      !Number.isInteger(limit) || limit < 1 || limit > 50000 || !Number.isInteger(delay) || delay < 0 || delay > 60000 ||
      args["source-id"] && !uuid(args["source-id"]) || args.cohort && !/^[a-z0-9_-]{1,80}$/.test(args.cohort)) throw new Error("Invalid worker scope");
  if (args.pilot === "true" && (!args["source-id"] || (args["run-trigger"] || "manual") !== "manual")) throw new Error("Pilots must name one source and run manually");
  return { ...args, mode: args.mode || "plan", apply: args.apply === "true", pilot: args.pilot === "true", shardCount, shardIndex, limit, delay };
}

function loadEnvironment(path) {
  // Native dotenv parsing avoids shell expansion. Never log this object.
  if (existsSync(path)) process.loadEnvFile(path);
  const env = process.env;
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Worker service credentials are not configured");
  return env;
}
async function rows(query) {
  const { data, error } = await query;
  if (error) throw new Error(`Text worker database request failed (${error.code || "database"})`);
  return data || [];
}

/** Uses approved required source identities; never discovers or approves pages. */
export async function loadProgramTextSources(supabase) {
  const manifest = await rows(supabase.from("stage1_award_source_manifest").select("cohort_key,source_role,source_ids,manifest_status,evidence").order("cohort_key").limit(1000));
  if (!manifest.length || manifest.length === 1000) throw new Error("Required source roster is missing or incomplete");
  const requiredIds = [...new Set(manifest.flatMap(role => role.source_ids || []))];
  if (!requiredIds.length || requiredIds.length > 500) throw new Error("Required source roster is out of bounds");
  const sources = await rows(supabase.from("shared_award_sources").select("id,shared_award_id,url,title,page_type,admin_review_status,text_monitoring_state")
    .in("id", requiredIds).order("id").limit(1000));
  const map = new Map(sources.map(source => [source.id, source]));
  if (sources.length !== requiredIds.length) throw new Error("Required source identities are incomplete");
  return { manifest, sources: sources.map(source => ({ ...source,
    cohorts: [...new Set(manifest.filter(role => role.source_ids?.includes(source.id)).map(role => role.cohort_key))],
    manifest_bound: manifest.filter(role => role.source_ids?.includes(source.id)).every(role => role.manifest_status !== "missing" && role.evidence?.source_bindings?.[source.id]?.source_url === source.url),
  })), map };
}

export function programTextCoverage({ manifest, sources }, epoch) {
  const byId = new Map(sources.map(source => [source.id, source]));
  return [...new Set(manifest.map(role => role.cohort_key))].map(cohort => {
    const roles = manifest.filter(role => role.cohort_key === cohort), ids = [...new Set(roles.flatMap(role => role.source_ids || []))];
    const complete = ids.filter(id => {
      const source = byId.get(id), state = source?.text_monitoring_state;
      try {
        if (source?.admin_review_status !== "open" || !source.manifest_bound || state?.schema !== "awardping.program-text-state.v1" ||
            state.epoch !== epoch || state.status !== "baseline_ready" || !Number.isInteger(state.successful_checks) || state.successful_checks < 2 ||
            state.successful_checks > 2147483647 || !Number.isFinite(Date.parse(state.first_captured_at)) ||
            !Number.isFinite(Date.parse(state.last_checked_at)) || Date.parse(state.first_captured_at) >= Date.parse(state.last_checked_at)) return false;
        for (const ref of [state.baseline_ref, state.latest_ref]) {
          validateProgramTextReference(ref);
          if (ref.source.id !== source.id || ref.source.shared_award_id !== source.shared_award_id || ref.source.url !== source.url) return false;
        }
        return state.baseline_ref.capture_id === state.latest_ref.capture_id && state.baseline_ref.text_sha256 === state.latest_ref.text_sha256 &&
          Date.parse(state.first_captured_at) < Date.parse(state.latest_ref.captured_at) &&
          Date.parse(state.last_checked_at) >= Date.parse(state.latest_ref.captured_at);
      } catch { return false; }
    });
    return { cohort, required_sources: ids.length, repeated_text_sources: complete.length,
      collection_complete: ids.length > 0 && roles.every(role => role.manifest_status !== "missing" && role.source_ids?.length) && complete.length === ids.length,
      // Factual/source-set acceptance is a separate review; do not overstate it.
      factual_review_complete: false };
  });
}

async function review(repository, options, callbacks, limit, scope) {
  const queued = await repository.listCandidates(["pending", "submitted", "succeeded"], limit, scope);
  const report = [];
  for (const row of queued) {
    try {
      await repository.verifyCandidate(row);
      let outcome;
      if (row.status === "pending" && row.prompt_payload.packet_plan.packets.length) {
        outcome = await submitProgramTextBatch(row, { ...options, claim: repository.claim, save: repository.save, verify: repository.verifyCandidate });
      } else {
        const completed = row.status === "submitted" ? await pollProgramTextBatch(row, options)
          : row.status === "succeeded" ? { status: "ready", responses: row.ai_result?.responses || [] }
            : { status: "ready", responses: [] };
        if (completed.status === "held") {
          await repository.save(row, row.worker_metadata.program_text_claim_token, { status: "failed", rejection_reason: `manual_review_required:${completed.reason}` });
          outcome = completed;
        } else if (completed.status === "ready") {
          outcome = await finalizeProgramTextReview({ source: row.new_snapshot_ref.source, epoch: row.worker_metadata.epoch,
            candidate: programTextCandidateWork(row), responses: completed.responses, callbacks: { ...callbacks,
              recordReviewResult: args => repository.recordReviewResult({ ...args, responses: completed.responses }) } });
          if (outcome.status === "no_program_change") await repository.finishNoChange(row.id);
        } else outcome = completed;
      }
      report.push({ candidate_id: row.id, status: outcome.status, reason: outcome.reason || null });
    } catch { report.push({ candidate_id: row.id, status: "held", reason: "review_state_or_transport_failed" }); }
  }
  return report;
}

export async function runProgramTextWorker(argv = process.argv.slice(2)) {
  const args = parseProgramTextArgs(argv), env = loadEnvironment(resolve(root, args.env || ".env.worker.local"));
  const config = JSON.parse(readFileSync(resolve(root, args.config || "config/program-text-monitoring.json"), "utf8"));
  if (config.schema !== "awardping.program-text-monitoring.v1" || !uuid(config.epoch)) throw new Error("Invalid text monitoring configuration");
  if (args.apply && ["collect", "review"].includes(args.mode) && !config.enabled && !args.pilot) throw new Error("Text monitoring activation has not been approved in the reviewed release configuration");
  const supabase = createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  let client;
  try {
    const roster = await loadProgramTextSources(supabase);
    const scopedSources = roster.sources.filter((source, index) => index % args.shardCount === args.shardIndex &&
      (!args["source-id"] || source.id === args["source-id"]) && (!args.cohort || source.cohorts.includes(args.cohort)));
    // Review --limit caps candidates below, not the source roster they may come
    // from. Collection keeps its existing per-run source limit.
    const selected = args.mode === "review" ? scopedSources : scopedSources.slice(0, args.limit);
    if (args["source-id"] && selected.length !== 1) throw new Error("The requested source is not in this shard's required roster");
    const report = { schema: "awardping.program-text-run.v1", mode: args.mode, epoch: config.epoch, apply: args.apply,
      selected_sources: selected.length, checked_at: new Date().toISOString(), coverage: programTextCoverage(roster, config.epoch), results: [] };
    if (!args.apply || ["plan", "report", "new_page_review", "legacy_hold"].includes(args.mode)) return report;
    const bucket = env.R2_BUCKET, endpoint = env.R2_ENDPOINT || (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null);
    if (!bucket || !endpoint || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) throw new Error("Private raw/text retention is not configured");
    client = new S3Client({ region: "auto", endpoint, maxAttempts: 1,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
    const storage = { client, bucket }, loadCapture = ref => loadProgramTextCapture(ref, storage);
    const repository = createProgramTextRepository(supabase, { loadCapture, bucket });
    const archive = env.AWARDPING_PROGRAM_TEXT_ARCHIVE;
    const callbacks = { ...repository, loadCapture, verifyRetention: loadCapture,
      retain: async capture => {
        if (!archive) throw new Error("Private text archive is not configured");
        retainProgramTextCapture(capture, realpathSync.native(resolve(archive)));
        return uploadProgramTextCapture(capture, storage);
      }, retainIncomplete: capture => { if (!archive) throw new Error("Private text archive is not configured"); return retainProgramTextCapture(capture, archive); } };
    if (args.mode === "review") {
      if (!env.GEMINI_API_KEY) throw new Error("Gemini review is not configured");
      report.results = await review(repository, { supabase, apiKey: env.GEMINI_API_KEY }, callbacks, Math.min(args.limit, 100),
        { source_ids: selected.filter(source => source.admin_review_status === "open" && source.manifest_bound).map(source => source.id), epoch: config.epoch });
      return report;
    }
    const runtimeFile = resolve(root, ".awardping-scrapling-runtime.json");
    const runtime = existsSync(runtimeFile) ? JSON.parse(readFileSync(runtimeFile, "utf8")) : {};
    const pythonPath = env.AWARDPING_SCRAPLING_PYTHON || runtime.python_executable;
    const lastDomain = new Map();
    for (const source of selected) {
      if (source.admin_review_status !== "open" || !source.manifest_bound) { report.results.push({ source_id: source.id, status: "held", reason: "source_not_approved" }); continue; }
      const override = config.sources?.[source.id] || {};
      if (override.source_url && override.source_url !== source.url || override.shared_award_id && override.shared_award_id !== source.shared_award_id) {
        report.results.push({ source_id: source.id, status: "held", reason: "source_configuration_changed" }); continue;
      }
      const domain = new URL(source.url).hostname, wait = (lastDomain.get(domain) || 0) + args.delay - Date.now();
      if (wait > 0) await new Promise(done => setTimeout(done, wait));
      const outcome = await monitorProgramTextSource({ source, epoch: config.epoch, callbacks,
        packetLimits: { max_blocks_per_packet: 6 }, captureOptions: { pythonPath,
          executablePath: env.BROWSER_EXECUTABLE_PATH || env.CHROME_PATH || env.EDGE_PATH,
          acquisition: override.acquisition || (source.page_type === "pdf" || /\.pdf(?:\?|$)/i.test(source.url) ? "pdf_text" : "http_html"),
          allowedFinalUrls: override.allowed_final_urls || [], ocrOptions: { popplerDirectory: env.AWARDPING_POPPLER_DIRECTORY,
            tempRoot: env.AWARDPING_OCR_TEMP_ROOT } } });
      lastDomain.set(domain, Date.now());
      report.results.push({ source_id: source.id, cohorts: source.cohorts, status: outcome.status, reason: outcome.reason || null,
        reasons: outcome.reasons || [], candidate_id: outcome.candidate_id || null, initial_coverage: outcome.initial_coverage === true });
    }
    return report;
  } finally { client?.destroy(); await closeSupabaseServiceTransport(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProgramTextWorker().then(report => {
    console.log(JSON.stringify(report));
    if (report.results.some(row => row.status === "held")) process.exitCode = 1;
  }).catch(() => { console.error("PROGRAM_TEXT_WORKER_FAILED: no automatic retry or publication was attempted after this failure."); process.exitCode = 1; });
}
