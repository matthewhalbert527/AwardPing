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
import { findProgramTextBrowserExecutable } from "./lib/program-text-browser.mjs";
import { isKnownProgramTextHtmlShellReference, isKnownProgramTextFooterOnlyPdfReference } from "./lib/program-text-capture-contract.mjs";
import { programTextDeterministicNoChange } from "./lib/program-text-deterministic-no-change.mjs";
import { hasProgramTextSourceAccess } from "./lib/program-text-source-access.mjs";
import { assertCurrentCanonicalUrlAdmission } from "./lib/program-text-canonical-url-admission.mjs";
import { validateProgramTextCollectionQuality, hasUnclearedProgramTextCollectionFailure } from "./lib/program-text-collection-quality.mjs";
import { hasPotentialProgramTextReview } from "./lib/program-text-review-queue.mjs";
import { createProgramTextHostPacer } from "./lib/program-text-host-pacing.mjs";
import { createScraplingBrowserSessionPool } from "./lib/scrapling-capture.mjs";
import { scheduledCollectionCycleStore, requestInstalledCoverageReport } from "./lib/program-text-cycle-runner.mjs";

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
  if (args["run-trigger"] !== undefined && !["scheduled", "maintenance", "manual"].includes(args["run-trigger"])) throw new Error("Invalid worker run trigger");
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
const rosterSchema = "awardping.program-text-worker-roster-page.v1", rosterPageSize = 100;
const rosterKey = (kind, row) => kind === "roles" ? [row.cohort_key, row.scope_key, row.source_role] : row.id;
const compareKeys = (a, b) => {
  const left = Array.isArray(a) ? a : [a], right = Array.isArray(b) ? b : [b];
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
};
const validRosterKey = (kind, key) => kind === "roles" ? Array.isArray(key) && key.length === 3 &&
  key.every((part, index) => typeof part === "string" && /^[a-z0-9_-]+$/.test(part) && part.length <= (index === 1 ? 200 : 80)) : uuid(key);

/** Bound every page to one identity seal; mutable capture state is independently CAS-checked by monitoring. */
export async function loadProgramTextSources(supabase, { epoch } = {}) {
  let identity;
  async function page(kind, after = null) {
    const { data, error } = await supabase.rpc("get_program_text_worker_roster_page", {
      p_kind: kind, p_after: after, p_expected_roster_seal: identity?.roster_seal || null, p_limit: rosterPageSize,
    });
    if (error) throw new Error(`Text worker database request failed (${error.code || "database"})`);
    if (!data || data.schema !== rosterSchema || !/^[a-f0-9]{64}$/.test(data.roster_seal || "") ||
        ![data.role_count, data.source_count, data.cohort_count].every(value => Number.isSafeInteger(value) && value > 0) ||
        !Array.isArray(data.entries) || data.entries.length > rosterPageSize || !Object.hasOwn(data, "next_cursor")) {
      throw new Error("Required source roster is missing or incomplete");
    }
    const current = { roster_seal: data.roster_seal, role_count: data.role_count, source_count: data.source_count, cohort_count: data.cohort_count };
    if (identity && Object.keys(identity).some(key => current[key] !== identity[key])) throw new Error("Required source roster changed during enumeration");
    identity ||= current;
    return data;
  }
  async function all(kind) {
    const entries = []; let after = null;
    while (true) {
      const result = await page(kind, after), count = kind === "roles" ? identity.role_count : identity.source_count;
      for (const row of result.entries) {
        const key = rosterKey(kind, row);
        if (!validRosterKey(kind, key) || after !== null && compareKeys(key, after) <= 0) throw new Error("Required source roster has duplicate or unordered identities");
        entries.push(row); after = key;
      }
      if (entries.length > count || result.next_cursor !== null &&
          (result.entries.length !== rosterPageSize || !validRosterKey(kind, result.next_cursor) || compareKeys(result.next_cursor, after) !== 0)) {
        throw new Error("Required source roster page is incomplete");
      }
      if (result.next_cursor === null) {
        if (entries.length !== count) throw new Error("Required source identities are incomplete");
        return entries;
      }
      if (entries.length === count) throw new Error("Required source roster cursor exceeds its count");
    }
  }
  const manifest = await all("roles"), sources = await all("sources");
  const checked = await page("check");
  if (checked.entries.length || checked.next_cursor !== null) throw new Error("Required source roster final check is invalid");
  const rolesById = new Map();
  for (const role of manifest) {
    if (!Array.isArray(role.source_ids) || role.source_ids.length < 1 || role.source_ids.length > 50 ||
        !role.source_ids.every(uuid) || new Set(role.source_ids).size !== role.source_ids.length) throw new Error("Required source roster role is invalid");
    for (const id of role.source_ids) {
      if (!rolesById.has(id)) rolesById.set(id, []);
      rolesById.get(id).push(role);
    }
  }
  if (rolesById.size !== identity.source_count || new Set(manifest.map(role => role.cohort_key)).size !== identity.cohort_count ||
      sources.some(source => !rolesById.has(source.id) || !uuid(source.shared_award_id) || typeof source.url !== "string")) {
    throw new Error("Required source identities are incomplete");
  }
  const map = new Map(sources.map(source => [source.id, source]));
  for (const source of sources) {
    try { validateProgramTextCollectionQuality(source.text_collection_quality, source); }
    catch { throw new Error("Required collection quality data is missing or invalid"); }
  }
  return { manifest, roster_seal: identity.roster_seal, sources: sources.map(source => ({ ...source,
    cohorts: [...new Set(rolesById.get(source.id).map(role => role.cohort_key))],
    manifest_bound: rolesById.get(source.id).every(role => hasProgramTextSourceAccess(source, { cohort: role.cohort_key, epoch }) && role.manifest_status === "reviewed_text" &&
      uuid(role.revision) && role.evidence?.schema === "awardping.program-text-source-role.v1" &&
      role.evidence?.source_bindings?.[source.id]?.source_url === source.url &&
      role.evidence?.source_bindings?.[source.id]?.shared_award_id === source.shared_award_id),
  })), map };
}

export function programTextCoverage({ manifest, sources }, epoch, factReviews = [], variationReviews = []) {
  const byId = new Map(sources.map(source => [source.id, source]));
  return [...new Set(manifest.map(role => role.cohort_key))].map(cohort => {
    const roles = manifest.filter(role => role.cohort_key === cohort), ids = [...new Set(roles.flatMap(role => role.source_ids || []))];
    const complete = ids.filter(id => {
      const source = byId.get(id), state = source?.text_monitoring_state;
      try {
        if (!hasProgramTextSourceAccess(source, { cohort, epoch }) || !source.manifest_bound || hasUnclearedProgramTextCollectionFailure(source, epoch) || state?.schema !== "awardping.program-text-state.v1" ||
            state.epoch !== epoch || state.status !== "baseline_ready" || !Number.isInteger(state.successful_checks) || state.successful_checks < 2 ||
            state.successful_checks > 2147483647 || !Number.isFinite(Date.parse(state.first_captured_at)) ||
            !Number.isFinite(Date.parse(state.last_checked_at)) || Date.parse(state.first_captured_at) >= Date.parse(state.last_checked_at)) return false;
        for (const ref of [state.baseline_ref, state.latest_ref]) {
          validateProgramTextReference(ref);
          if (isKnownProgramTextHtmlShellReference(ref) || isKnownProgramTextFooterOnlyPdfReference(ref)) return false;
          if (ref.source.id !== source.id || ref.source.shared_award_id !== source.shared_award_id || ref.source.url !== source.url) return false;
        }
        return state.baseline_ref.capture_id === state.latest_ref.capture_id && state.baseline_ref.text_sha256 === state.latest_ref.text_sha256 &&
          Date.parse(state.first_captured_at) < Date.parse(state.latest_ref.captured_at) &&
          Date.parse(state.last_checked_at) >= Date.parse(state.latest_ref.captured_at);
      } catch { return false; }
    });
    const collectionComplete = ids.length > 0 && roles.every(role => role.manifest_status === "reviewed_text" && role.source_ids?.length) && complete.length === ids.length;
    const approved = factReviews.filter(row => row.cohort_key === cohort);
    const receipt = approved.length === 1 ? approved[0] : null;
    const reviewedIds = receipt?.sources?.map(source => source.id);
    const variationRows = variationReviews.filter(row => row.cohort_key === cohort), variation = variationRows.length === 1 ? variationRows[0] : null;
    const variationMode = variationRows.length > 1 || variation?.inventory_sealed === true || variation?.draft_inventory_id != null;
    const variationIds = variation?.approved_source_ids;
    const variantCount = variation?.expected_variants;
    const variationComplete = variation?.inventory_sealed === true && uuid(variation.approval_id) && variation.current === true &&
      variation.draft_inventory_id === null && Array.isArray(variation.blockers) && !variation.blockers.length &&
      Number.isSafeInteger(variantCount) && variantCount >= 0 && Number.isSafeInteger(variation.scope_total) && variation.scope_total > 0 &&
      [variation.total_variants, variation.reviewed_variants, variation.ready_variants, variation.approved_variants, variation.current_approved_variants].every(value => value === variantCount) &&
      Array.isArray(variationIds) && variationIds.every(uuid) && variationIds.length === ids.length && variation.source_count === ids.length &&
      new Set(variationIds).size === ids.length && ids.every(id => variationIds.includes(id));
    return { cohort, required_sources: ids.length, repeated_text_sources: complete.length,
      collection_complete: collectionComplete,
      inventory_sealed: variation?.inventory_sealed === true, variation_scope_total: variation?.scope_total || 0,
      total_variants: variantCount || 0, reviewed_variants: variation?.reviewed_variants || 0,
      factual_review_complete: collectionComplete && (variationMode ? variationComplete : receipt?.review?.status === "approved" && receipt.review.current === true &&
        uuid(receipt.review.id) && Array.isArray(reviewedIds) && reviewedIds.length === ids.length &&
        new Set(reviewedIds).size === ids.length && ids.every(id => reviewedIds.includes(id))),
    };
  });
}

/** Reporting the current basic-information purpose does not require the retired
 * complete-program/variation review batch or assume a fixed award count. */
export async function loadProgramTextBasicStatus(supabase, roster) {
  const cohorts = new Set(roster.manifest.map(role => role.cohort_key));
  const { data, error } = await supabase.rpc("get_program_award_monitoring_basics");
  if (error || data?.schema !== "awardping.program-award-monitoring-basics.v1" ||
      !Array.isArray(data.awards) || data.awards.length !== cohorts.size) {
    throw new Error("Current basic-information coverage is unavailable");
  }
  const rows = new Map(), owners = new Set();
  for (const row of data.awards) {
    if (!row || Object.keys(row).sort().join() !== "award_id,basic_details_current,cohort_key,snapshot_id" ||
        !cohorts.has(row.cohort_key) || rows.has(row.cohort_key) || !uuid(row.award_id) || owners.has(row.award_id) ||
        !(row.snapshot_id === null || uuid(row.snapshot_id)) || typeof row.basic_details_current !== "boolean" ||
        row.snapshot_id === null && row.basic_details_current) {
      throw new Error("Current basic-information identities are incomplete");
    }
    owners.add(row.award_id); rows.set(row.cohort_key, row);
  }
  return rows;
}

export async function review(repository, options, callbacks, limit, scope) {
  const queued = await repository.listCandidates(["pending", "submitted", "succeeded"], limit, scope);
  const report = [];
  for (const row of queued) {
    try {
      await repository.verifyCandidate(row);
      const local = programTextDeterministicNoChange(row);
      let outcome;
      if (!local && row.status === "pending" && row.prompt_payload.packet_plan.packets.length) {
        outcome = await submitProgramTextBatch(row, { ...options, claim: repository.claim, save: repository.save, verify: repository.verifyCandidate });
      } else {
        const completed = local || (row.status === "submitted" ? await pollProgramTextBatch(row, options)
          : row.status === "succeeded" ? { status: "ready", responses: row.ai_result?.responses || [] }
            : { status: "ready", responses: [] });
        if (completed.status === "held") {
          await repository.save(row, row.worker_metadata.program_text_claim_token, { status: "failed", rejection_reason: `manual_review_required:${completed.reason}` });
          outcome = completed;
        } else if (completed.status === "ready") {
          outcome = await finalizeProgramTextReview({ source: row.new_snapshot_ref.source, epoch: row.worker_metadata.epoch,
            candidate: programTextCandidateWork(row), responses: completed.responses, callbacks: { ...callbacks,
              recordReviewResult: args => repository.recordReviewResult({ ...args, responses: completed.responses,
                ...(local ? { deterministicCandidate: row } : row.status === "succeeded" &&
                  row.ai_result?.program_text_review_provenance?.schema === "awardping.deterministic-program-text-no-change.v1"
                  ? { deterministicProvenance: row.ai_result.program_text_review_provenance } : {}) }) } });
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
  let client, browserSessionPool, cycleStore, collectionHandle, reportClaim, completedReport;
  let collectionSucceeded = false, reportSucceeded = false;
  try {
    // The scheduled reviewer is unscoped. Explicit source/cohort/shard requests
    // still enumerate and validate their requested roster, including empty or
    // invalid scopes, before querying any candidate queue.
    if (args.apply && args.mode === "review" && !args["source-id"] && !args.cohort && args.shardCount === 1 &&
        !await hasPotentialProgramTextReview(supabase, { epoch: config.epoch })) {
      return { schema: "awardping.program-text-run.v1", mode: args.mode, epoch: config.epoch, apply: true,
        selected_sources: 0, roster_seal: null, checked_at: new Date().toISOString(), coverage: [], results: [],
        queue_state: "idle", roster_checked: false };
    }
    const roster = await loadProgramTextSources(supabase, { epoch: config.epoch });
    const scopedSources = roster.sources.filter((source, index) => index % args.shardCount === args.shardIndex &&
      (!args["source-id"] || source.id === args["source-id"]) && (!args.cohort || source.cohorts.includes(args.cohort)));
    cycleStore = scheduledCollectionCycleStore({ env, args, root, epoch: config.epoch, rosterSeal: roster.roster_seal,
      scopedSourceCount: scopedSources.length });
    if (cycleStore && args.mode === "collect") collectionHandle = await cycleStore.begin(args.shardIndex);
    if (cycleStore && args.mode === "report") {
      reportClaim = await cycleStore.claimReport({ allowExpired: true });
      if (!reportClaim) return { schema: "awardping.program-text-run.v1", mode: args.mode, epoch: config.epoch, apply: true,
        selected_sources: 0, roster_seal: roster.roster_seal, checked_at: new Date().toISOString(), coverage: [], results: [],
        report_state: "waiting_or_already_reported", roster_checked: true };
    }
    // Historical complete-program and application-route approvals remain private
    // history. Report the supported basic details across the actual current roster.
    const factReviews = [], variationReviews = [];
    let basicStatuses = null;
    if (!["collect", "review"].includes(args.mode)) {
      basicStatuses = await loadProgramTextBasicStatus(supabase, roster);
    }
    const coverage = () => programTextCoverage(roster, config.epoch, factReviews, variationReviews).map(row => ({ ...row,
      ...(basicStatuses ? { basic_details_current: basicStatuses.get(row.cohort).basic_details_current,
        basic_snapshot_id: basicStatuses.get(row.cohort).snapshot_id } : {}) }));
    // Review --limit caps candidates below, not the source roster they may come
    // from. Collection keeps its existing per-run source limit.
    const selected = args.mode === "review" ? scopedSources : scopedSources.slice(0, args.limit);
    if (args["source-id"] && selected.length !== 1) throw new Error("The requested source is not in this shard's required roster");
    const report = { schema: "awardping.program-text-run.v1", mode: args.mode, epoch: config.epoch, apply: args.apply,
      selected_sources: selected.length, roster_seal: roster.roster_seal, checked_at: new Date().toISOString(), coverage: coverage(), results: [] };
    completedReport = report;
    if (reportClaim) report.collection_cycle = reportClaim.cycle;
    if (!args.apply || ["plan", "report", "new_page_review", "legacy_hold"].includes(args.mode)) { reportSucceeded = true; return report; }
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
        { source_ids: selected.filter(source => hasProgramTextSourceAccess(source, { epoch: config.epoch }) && source.manifest_bound).map(source => source.id), epoch: config.epoch });
      return report;
    }
    const runtimeFile = resolve(root, ".awardping-scrapling-runtime.json");
    const runtime = existsSync(runtimeFile) ? JSON.parse(readFileSync(runtimeFile, "utf8")) : {};
    const pythonPath = env.AWARDPING_SCRAPLING_PYTHON || runtime.python_executable;
    const hostPacer = createProgramTextHostPacer({ directory: resolve(env.AWARDPING_WORKER_DATA_ROOT || resolve(root, "..", "data"), "host-pacing"), delayMs: args.delay });
    browserSessionPool = createScraplingBrowserSessionPool();
    for (const source of selected) {
      if (!hasProgramTextSourceAccess(source, { epoch: config.epoch }) || !source.manifest_bound) { report.results.push({ source_id: source.id, status: "held", reason: "source_not_approved" }); continue; }
      const override = config.sources?.[source.id] || {};
      if (override.source_url && override.source_url !== source.url || override.shared_award_id && override.shared_award_id !== source.shared_award_id ||
          (override.source_title !== undefined || override.page_type !== undefined) && (override.source_title !== source.title || override.page_type !== source.page_type)) {
        report.results.push({ source_id: source.id, status: "held", reason: "source_configuration_changed" }); continue;
      }
      let outcome;
      try { outcome = await hostPacer.run([source.url, ...(override.allowed_final_urls || [])], async () => {
        // Recheck the finite current-roster identity after the shared host wait.
        try { await assertCurrentCanonicalUrlAdmission(supabase, source, { epoch: config.epoch }); }
        catch { return { status: "held", reason: "canonical_url_admission_changed" }; }
        return monitorProgramTextSource({ source, epoch: config.epoch, callbacks,
        packetLimits: { max_blocks_per_packet: 6 }, captureOptions: { pythonPath, browserSessionPool,
          executablePath: findProgramTextBrowserExecutable(env),
          acquisition: override.acquisition || (source.page_type === "pdf" || /\.pdf(?:\?|$)/i.test(source.url) ? "pdf_text" : "http_html"),
          pdf_transport: override.pdf_transport || "http",
          ...(override.publisher_json_profile === undefined ? {} : { publisher_json_profile: override.publisher_json_profile }),
          allowedFinalUrls: override.allowed_final_urls || [], ocrOptions: { popplerDirectory: env.AWARDPING_POPPLER_DIRECTORY,
            tempRoot: env.AWARDPING_OCR_TEMP_ROOT } } });
      }); } catch { outcome = { status: "held", reason: "shared_collection_transport_failed" }; }
      if (["canonical_url_admission_changed", "shared_collection_transport_failed"].includes(outcome.reason)) {
        report.results.push({ source_id: source.id, status: "held", reason: outcome.reason }); continue;
      }
      if (outcome.state) source.text_monitoring_state = outcome.state;
      if (outcome.collection_failure_recorded === true) source.text_collection_quality = outcome.collection_failure.failure;
      else if (outcome.collection_failure_recorded === false) source.text_collection_quality = undefined;
      report.results.push({ source_id: source.id, cohorts: source.cohorts, status: outcome.status, reason: outcome.reason || null,
        reasons: outcome.reasons || [], candidate_id: outcome.candidate_id || null, initial_coverage: outcome.initial_coverage === true,
        ...(Object.hasOwn(outcome, "collection_failure_recorded") ? { collection_failure_recorded: outcome.collection_failure_recorded,
          collection_failure_journal_reason: outcome.collection_failure_journal_reason || null } : {}) });
    }
    report.coverage = coverage();
    collectionSucceeded = report.results.every(row => row.status !== "held");
    return report;
  } finally {
    try {
      let browserCloseError;
      try { await browserSessionPool?.close(); }
      catch (error) { browserCloseError = error; collectionSucceeded = false; }
      if (collectionHandle) {
        const finished = await cycleStore.finish(collectionHandle, { status: collectionSucceeded ? "succeeded" : "failed",
          reason: collectionSucceeded ? null : "collection_incomplete" });
        if (completedReport) completedReport.collection_cycle = finished.cycle;
        if (finished.reportReady) {
          const trigger = await requestInstalledCoverageReport();
          if (completedReport) completedReport.coverage_report_trigger = trigger;
        }
      }
      if (reportClaim) await cycleStore.finishReport(reportClaim, { status: reportSucceeded ? "succeeded" : "failed" });
      if (browserCloseError) throw browserCloseError;
    } finally { client?.destroy(); await closeSupabaseServiceTransport(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProgramTextWorker().then(report => {
    console.log(JSON.stringify(report));
    if (report.results.some(row => row.status === "held")) process.exitCode = 1;
  }).catch(() => { console.error("PROGRAM_TEXT_WORKER_FAILED: no automatic retry or publication was attempted after this failure."); process.exitCode = 1; });
}
