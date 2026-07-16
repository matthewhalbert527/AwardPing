#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { geminiWorkerModel } from "./lib/gemini-worker-policy.mjs";
import {
  extractGeminiBatchInlineResponses,
  geminiBatchInlineResponseMap,
  geminiBatchOutputFileNames,
  geminiInlineError,
  geminiInlineResponsePayload,
} from "./lib/gemini-batch-support.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
if (boolArg(args.help, false)) {
  printHelp();
  process.exit(0);
}

const envPath = args.env
  ? resolve(root, String(args.env))
  : existsSync(resolve(root, ".env.worker.local"))
    ? resolve(root, ".env.worker.local")
    : resolve(root, ".env.local");
const env = { ...loadEnvFile(envPath), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const geminiApiKey = env.GEMINI_API_KEY;
const limit = positiveInt(args.limit, 100);
const maxRequestsPerBatch = positiveInt(args["max-requests-per-batch"], 100);
const model = geminiWorkerModel();
const apply = boolArg(args.apply, true);
const requestedSubmit = boolArg(args.submit, false);
// Permanent policy: page auditing is deterministic and no longer creates a
// third paid Gemini pipeline. This script may only poll/reconcile historical
// jobs that were submitted before the policy changed.
const submit = false;
const poll = boolArg(args.poll, true);
const pollOnly = boolArg(args["poll-only"], false);
const submitOnly = boolArg(args["submit-only"], false);
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(reportDir, `page-audit-batch-${timestampForPath(new Date().toISOString())}.json`);
const journalPath = args.journal
  ? resolve(root, String(args.journal))
  : join(reportDir, "page-audit-batch-journal.json");
const requestTimeoutMs = positiveInt(args["request-timeout-ms"], 120_000);
const pageAuditResponseSchema = {
  type: "object",
  properties: {
    audit_status: { type: "string", enum: ["passed", "warnings", "failed", "needs_review"] },
    severity: { type: "string", enum: ["info", "warning", "error", "critical"] },
    findings: compactAuditStringArray("Up to four concise, evidence-bound findings."),
    suggested_fixes: compactAuditStringArray("Up to four concise fixes citing an exact quote, source, or candidate id."),
    source_rejections: compactAuditStringArray("Up to four source rejection decisions with a specific reason."),
    field_corrections: compactAuditStringArray("Up to four evidence-backed field corrections."),
    organization_corrections: compactAuditStringArray("Up to four concise page organization corrections."),
    should_block_publication: { type: "boolean" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: [
    "audit_status",
    "severity",
    "findings",
    "suggested_fixes",
    "source_rejections",
    "field_corrections",
    "organization_corrections",
    "should_block_publication",
    "confidence",
  ],
};

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}
if (!geminiApiKey && poll) {
  console.error("GEMINI_API_KEY is required to process page audit batches.");
  process.exit(1);
}

mkdirSync(reportDir, { recursive: true });
const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
let batchJournal = loadBatchJournal();
const report = {
  started_at: new Date().toISOString(),
  finished_at: null,
  status: "running",
  env_path: envPath,
  report_path: reportPath,
  options: {
    limit,
    max_requests_per_batch: maxRequestsPerBatch,
    model,
    apply,
    submit,
    requested_submit: requestedSubmit,
    submission_policy: "retired_no_third_paid_lane",
    poll,
    journal_path: journalPath,
  },
  page_audit_batch_candidates: 0,
  submitted_jobs: 0,
  submitted_audits: 0,
  reconciled: 0,
  failed: 0,
  skipped_existing_audits: 0,
  retrying_failed_audits: 0,
  recovered_unpersisted_jobs: 0,
  dry_run_audits: 0,
  errors: [],
  batches: [],
};

if (requestedSubmit) {
  report.errors.push({
    severity: "warning",
    message: "Gemini page-audit submission is retired. Deterministic page auditing runs in the no-cost page_audit lane; only historical Gemini jobs will be polled.",
  });
}

writeReport();
try {
  if (apply) await recoverUnpersistedBatchJobs();
  if (poll && !submitOnly) await pollExistingBatches();
  if (submit && !pollOnly) await submitFlaggedAudits();
  report.status = "succeeded";
} catch (error) {
  report.status = "failed";
  report.errors.push({ message: errorMessage(error) });
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  writeReport();
  console.log(`PAGE_AUDIT_BATCH_REPORT ${reportPath}`);
}

async function pollExistingBatches() {
  const { data, error } = await supabase
    .from("shared_award_page_audits")
    .select("gemini_batch_name")
    .eq("audit_kind", "gemini_batch")
    .is("ai_result", null)
    .not("gemini_batch_name", "is", null)
    .limit(10_000);
  if (error) {
    if (isMissingTableError(error)) return;
    throw new Error(`Load submitted page audit batches failed: ${error.message}`);
  }
  for (const batchName of unique((data || []).map((row) => row.gemini_batch_name))) {
    const job = await fetchGeminiJson(`https://generativelanguage.googleapis.com/v1beta/${batchName}`, {
      method: "GET",
      kind: "page_audit_batch_poll",
    });
    const state = geminiBatchState(job);
    const batchReport = { name: batchName, state, reconciled: 0, failed: 0, mode: "poll" };
    report.batches.push(batchReport);
    if (!isGeminiBatchDone(state)) continue;
    if (!isGeminiBatchSucceeded(state)) {
      await markBatchFailed(batchName, geminiBatchErrorMessage(job));
      batchReport.failed += 1;
      report.failed += 1;
      continue;
    }
    const responseMap = await geminiBatchResponseMap(job);
    const { data: audits, error } = await supabase
      .from("shared_award_page_audits")
      .select("*")
      .eq("audit_kind", "gemini_batch")
      .eq("gemini_batch_name", batchName)
      .is("ai_result", null);
    if (error) throw new Error(`Load page audits for batch failed: ${error.message}`);
    for (const audit of audits || []) {
      const item = responseMap.get(audit.gemini_batch_request_key) || responseMap.get(audit.id);
      if (!item) {
        await updateAudit(audit.id, { ai_result: { error: "missing_batch_response" }, audit_status: "needs_review", severity: "error" });
        report.failed += 1;
        batchReport.failed += 1;
        continue;
      }
      const itemError = geminiInlineError(item);
      if (itemError) {
        await updateAudit(audit.id, {
          ai_result: { error: geminiInlineErrorMessage(itemError) },
          audit_status: "needs_review",
          severity: "error",
        });
        report.failed += 1;
        batchReport.failed += 1;
        continue;
      }
      const rawText = extractGeminiText(geminiInlineResponsePayload(item));
      const result = parseJsonObject(rawText);
      if (!result) {
        await updateAudit(audit.id, { ai_result: { raw_text: rawText, error: "invalid_json" }, audit_status: "needs_review", severity: "error" });
        report.failed += 1;
        batchReport.failed += 1;
        continue;
      }
      await updateAudit(audit.id, normalizedAuditPatch(result));
      report.reconciled += 1;
      batchReport.reconciled += 1;
    }
  }
}

async function submitFlaggedAudits() {
  const { data, error } = await supabase
    .from("shared_award_page_audits")
    .select("*", { count: "exact" })
    .eq("audit_kind", "deterministic")
    .in("audit_status", ["warnings", "failed", "needs_review"])
    .is("resolved_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTableError(error)) return;
    throw new Error(`Load flagged page audits failed: ${error.message}`);
  }
  const latestByAward = new Map();
  for (const audit of data || []) {
    if (!latestByAward.has(audit.shared_award_id)) latestByAward.set(audit.shared_award_id, audit);
  }
  const latestAudits = [...latestByAward.values()];
  const existingRequests = await loadExistingBatchRequestState(latestAudits.map((audit) => audit.id));
  const audits = latestAudits.filter((audit) => !existingRequests.blocked.has(audit.id));
  report.page_audit_batch_candidates = audits.length;
  report.skipped_existing_audits += existingRequests.blocked.size;
  report.retrying_failed_audits += audits.filter((audit) => existingRequests.retryable.has(audit.id)).length;
  if (!apply) {
    report.dry_run_audits += audits.length;
    return;
  }
  for (const chunk of chunks(audits, maxRequestsPerBatch)) {
    await submitAuditChunk(chunk);
  }
}

async function recoverUnpersistedBatchJobs() {
  for (const entry of batchJournal.jobs.filter((job) => !job.persisted_at)) {
    const requestKeys = unique(entry.request_keys);
    if (!entry.batch_name || !requestKeys.length) continue;
    const audits = [];
    for (const requestChunk of chunks(requestKeys, 200)) {
      const { data, error } = await supabase
        .from("shared_award_page_audits")
        .select("*")
        .eq("audit_kind", "deterministic")
        .in("id", requestChunk);
      if (error) throw new Error(`Recover page audit journal inputs failed: ${error.message}`);
      audits.push(...(data || []));
    }
    if (audits.length !== requestKeys.length) {
      throw new Error(`Recover page audit journal failed for ${entry.batch_name}: expected ${requestKeys.length} deterministic audits, found ${audits.length}.`);
    }
    await persistPageAuditBatchRows(entry.batch_name, pageAuditRowsForBatch(audits, entry.batch_name));
    markJournalJobPersisted(entry.batch_name);
    report.recovered_unpersisted_jobs += 1;
  }
}

async function loadExistingBatchRequestState(requestKeys) {
  const rowsByRequestKey = new Map();
  for (const requestChunk of chunks(unique(requestKeys), 200)) {
    if (!requestChunk.length) continue;
    const { data, error } = await supabase
      .from("shared_award_page_audits")
      .select("gemini_batch_request_key,ai_result")
      .eq("audit_kind", "gemini_batch")
      .in("gemini_batch_request_key", requestChunk);
    if (error) throw new Error(`Load existing page audit Batch requests failed: ${error.message}`);
    for (const row of data || []) {
      if (!row.gemini_batch_request_key) continue;
      const rows = rowsByRequestKey.get(row.gemini_batch_request_key) || [];
      rows.push(row);
      rowsByRequestKey.set(row.gemini_batch_request_key, rows);
    }
  }

  const blocked = new Set();
  const retryable = new Set();
  for (const [requestKey, rows] of rowsByRequestKey) {
    const hasActiveAttempt = rows.some((row) => row.ai_result === null || row.ai_result === undefined);
    const hasSuccessfulAttempt = rows.some((row) => !pageAuditResultIsRetryableFailure(row.ai_result));
    if (hasActiveAttempt || hasSuccessfulAttempt || rows.length >= 2) {
      blocked.add(requestKey);
    } else {
      retryable.add(requestKey);
    }
  }
  return { blocked, retryable };
}

async function submitAuditChunk(audits) {
  if (!audits.length) return;
  const displayName = `awardping-page-audit-${timestampForPath(new Date().toISOString())}-${model.replace(/[^a-z0-9._-]+/gi, "-")}`;
  const requests = audits.map((audit) => ({
    request: {
      systemInstruction: {
        parts: [{ text: "You are a strict AwardPing public-page auditor. Return JSON only. Never invent facts; suggested fixes must cite candidate ids or exact evidence quotes." }],
      },
      contents: [{ role: "user", parts: [{ text: buildPrompt(audit) }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1600,
        responseMimeType: "application/json",
        responseSchema: pageAuditResponseSchema,
      },
    },
    metadata: { key: audit.id, deterministic_audit_id: audit.id },
  }));
  const batch = await fetchGeminiJson(geminiBatchUrl(model), {
    method: "POST",
    body: JSON.stringify({ batch: { displayName, inputConfig: { requests: { requests } } } }),
    kind: "page_audit_batch_create",
  });
  const batchName = geminiBatchJobName(batch);
  if (!batchName) throw new Error(`Gemini page audit batch did not return a batch name: ${JSON.stringify(batch).slice(0, 500)}`);

  report.submitted_jobs += 1;
  report.submitted_audits += audits.length;
  report.batches.push({ name: batchName, model, submitted_audits: audits.length, persisted: false });
  recordJournalJob(batchName, audits.map((audit) => audit.id));
  writeReport();

  await persistPageAuditBatchRows(batchName, pageAuditRowsForBatch(audits, batchName));
  markJournalJobPersisted(batchName);
  report.batches.at(-1).persisted = true;
  writeReport();
}

function pageAuditRowsForBatch(audits, batchName) {
  return audits.map((audit) => ({
    shared_award_id: audit.shared_award_id,
    audit_kind: "gemini_batch",
    audit_status: "needs_review",
    severity: audit.severity || "warning",
    findings: audit.findings || [],
    suggested_fixes: audit.suggested_fixes || [],
    field_conflicts: audit.field_conflicts || [],
    source_rejections: audit.source_rejections || [],
    selected_fact_summary: audit.selected_fact_summary || {},
    public_page_snapshot: audit.public_page_snapshot || {},
    model,
    gemini_batch_name: batchName,
    gemini_batch_request_key: audit.id,
  }));
}

async function persistPageAuditBatchRows(batchName, rows) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const { data: existing, error: loadError } = await supabase
      .from("shared_award_page_audits")
      .select("gemini_batch_request_key")
      .eq("audit_kind", "gemini_batch")
      .eq("gemini_batch_name", batchName);
    if (loadError) {
      lastError = loadError;
    } else {
      const existingKeys = new Set((existing || []).map((row) => row.gemini_batch_request_key).filter(Boolean));
      const missingRows = rows.filter((row) => !existingKeys.has(row.gemini_batch_request_key));
      if (!missingRows.length) return;
      const { error: insertError } = await supabase.from("shared_award_page_audits").insert(missingRows);
      if (!insertError) return;
      lastError = insertError;
    }
    if (attempt < 4) await sleep(attempt * 1_500);
  }
  throw new Error(`Persist page audit batch rows failed for ${batchName}: ${lastError?.message || "unknown Supabase error"}`);
}

function buildPrompt(audit) {
  return [
    "Audit this reconciled public award page. Default to needs_review when uncertain.",
    "Reject sibling sources, unsupported descriptions, invented dates, stale cycle states, rejected-source facts, vague materials, and generic listing facts.",
    "Apply suggestions only if supported by candidate ids, exact evidence quotes, or the supplied public page snapshot.",
    "Return only the four most important items in each list. Keep every list item under 160 characters.",
    "Required JSON:",
    '{"audit_status":"passed|warnings|failed|needs_review","severity":"info|warning|error|critical","findings":[],"suggested_fixes":[],"source_rejections":[],"field_corrections":[],"organization_corrections":[],"should_block_publication":true,"confidence":"high|medium|low"}',
    "Deterministic audit:",
    JSON.stringify({
      id: audit.id,
      shared_award_id: audit.shared_award_id,
      audit_status: audit.audit_status,
      severity: audit.severity,
      findings: audit.findings,
      field_conflicts: audit.field_conflicts,
      source_rejections: audit.source_rejections,
      selected_fact_summary: audit.selected_fact_summary,
      public_page_snapshot: audit.public_page_snapshot,
    }),
  ].join("\n");
}

function normalizedAuditPatch(result) {
  const status = cleanChoice(result.audit_status, ["passed", "warnings", "failed", "needs_review"], "needs_review");
  const severity = cleanChoice(result.severity, ["info", "warning", "error", "critical"], status === "passed" ? "info" : "error");
  return {
    audit_status: status,
    severity,
    findings: Array.isArray(result.findings) ? result.findings : [],
    suggested_fixes: Array.isArray(result.suggested_fixes) ? result.suggested_fixes : [],
    source_rejections: Array.isArray(result.source_rejections) ? result.source_rejections : [],
    ai_result: result,
  };
}

async function updateAudit(id, patch) {
  const { error } = await supabase.from("shared_award_page_audits").update(patch).eq("id", id);
  if (error) throw new Error(`Update page audit failed: ${error.message}`);
}

async function markBatchFailed(batchName, message) {
  const { error } = await supabase
    .from("shared_award_page_audits")
    .update({ ai_result: { error: message }, audit_status: "needs_review", severity: "error" })
    .eq("audit_kind", "gemini_batch")
    .eq("gemini_batch_name", batchName)
    .is("ai_result", null);
  if (error) throw new Error(`Mark page audit batch failed failed: ${error.message}`);
}

function geminiBatchUrl(value) {
  const modelName = String(value || "").replace(/^models\//, "");
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:batchGenerateContent`;
}

async function fetchGeminiJson(url, { method, body, kind }) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json", "x-goog-api-key": geminiApiKey },
        body,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const text = await response.text().catch(() => "");
      if (response.ok) return JSON.parse(text);
      const message = `Gemini ${kind} failed: ${response.status} ${text.slice(0, 500)}`;
      if (attempt >= maxAttempts || ![408, 409, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(message);
      await sleep(attempt * 1_500);
    } catch (error) {
      if (attempt >= maxAttempts || !/(fetch failed|network|timeout|econnreset|etimedout|socket|high demand)/i.test(errorMessage(error))) throw error;
      await sleep(attempt * 1_500);
    }
  }
  throw new Error(`Gemini ${kind} failed after ${maxAttempts} attempts.`);
}

async function geminiBatchResponseMap(job) {
  const responses = [...extractGeminiBatchInlineResponses(job)];
  for (const fileName of geminiBatchOutputFileNames(job)) {
    const text = await downloadGeminiFileText(fileName);
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseJsonObject(line);
      if (parsed) responses.push(parsed);
    }
  }
  return geminiBatchInlineResponseMap(responses).responses;
}

async function downloadGeminiFileText(fileName) {
  const urls = [
    `https://generativelanguage.googleapis.com/v1beta/${fileName}:download?alt=media&key=${encodeURIComponent(geminiApiKey)}`,
    `https://generativelanguage.googleapis.com/v1beta/${fileName}?alt=media&key=${encodeURIComponent(geminiApiKey)}`,
  ];
  let lastError = null;
  for (const url of urls) {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(requestTimeoutMs) });
    const text = await response.text().catch(() => "");
    if (response.ok) return text;
    lastError = `${response.status} ${text}`;
  }
  throw new Error(`Gemini file download failed for ${fileName}: ${lastError || "unknown error"}`);
}

function geminiInlineErrorMessage(error) {
  if (!error) return "No error details returned.";
  if (typeof error === "string") return error;
  return cleanNullable(error.message || error.status || JSON.stringify(error)) || "Unknown Gemini item error.";
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || payload?.response?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || "").join("\n").trim();
}

function geminiBatchJobName(data) {
  return [data?.name, data?.metadata?.name, data?.response?.name].find((value) => typeof value === "string" && value.startsWith("batches/")) || null;
}

function geminiBatchState(data) {
  return cleanNullable(data?.metadata?.state || data?.response?.state || data?.state || data?.metadata?.batchState || data?.metadata?.batch_state);
}

function isGeminiBatchDone(state) {
  return new Set(["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "BATCH_STATE_SUCCEEDED", "BATCH_STATE_FAILED", "BATCH_STATE_CANCELLED", "BATCH_STATE_EXPIRED"]).has(state);
}

function isGeminiBatchSucceeded(state) {
  return new Set(["JOB_STATE_SUCCEEDED", "BATCH_STATE_SUCCEEDED"]).has(state);
}

function geminiBatchErrorMessage(job) {
  return cleanNullable(job?.error?.message || job?.metadata?.error?.message || job?.response?.error?.message) || "Gemini page audit batch failed.";
}

function writeReport() {
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}

function loadBatchJournal() {
  if (!existsSync(journalPath)) return { version: 1, jobs: [] };
  try {
    const parsed = JSON.parse(readFileSync(journalPath, "utf8"));
    return {
      version: 1,
      jobs: Array.isArray(parsed?.jobs) ? parsed.jobs.filter((job) => !job.persisted_at) : [],
    };
  } catch (error) {
    throw new Error(`Load page audit Batch journal failed: ${errorMessage(error)}`);
  }
}

function recordJournalJob(batchName, requestKeys) {
  if (!batchJournal.jobs.some((job) => job.batch_name === batchName)) {
    batchJournal.jobs.push({
      batch_name: batchName,
      model,
      request_keys: unique(requestKeys),
      submitted_at: new Date().toISOString(),
      persisted_at: null,
    });
  }
  writeBatchJournal();
}

function markJournalJobPersisted(batchName) {
  batchJournal.jobs = batchJournal.jobs.filter((job) => job.batch_name !== batchName);
  writeBatchJournal();
}

function writeBatchJournal() {
  const temporaryPath = `${journalPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(batchJournal, null, 2), "utf8");
  renameSync(temporaryPath, journalPath);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
    else {
      const next = values[index + 1];
      if (next && !next.startsWith("--")) {
        parsed[withoutPrefix] = next;
        index += 1;
      } else parsed[withoutPrefix] = "true";
    }
  }
  return parsed;
}

function loadEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function parseJsonObject(text) {
  const clean = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (!clean) return null;
  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanNullable(value) {
  const text = String(value || "").trim();
  return text || null;
}

function cleanChoice(value, allowed, fallback) {
  const clean = String(value || "").trim().toLowerCase();
  return allowed.includes(clean) ? clean : fallback;
}

function compactAuditStringArray(description) {
  return {
    type: "array",
    description,
    maxItems: 4,
    items: { type: "string" },
  };
}

function pageAuditResultIsRetryableFailure(value) {
  if (!value || typeof value !== "object") return false;
  const error = cleanNullable(value.error);
  return error === "invalid_json" || error === "missing_batch_response";
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function isMissingTableError(error) {
  return /does not exist|schema cache|relation .* not found/i.test(error?.message || "");
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function errorMessage(error) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Poll and reconcile historical Gemini page-audit jobs created before paid page-audit submission was retired.

Current page auditing is deterministic and runs in the no-cost page_audit lane. This command never submits a new paid request.

Options:
  --limit=100
  --poll=true
  --poll-only=false
  --apply=true
  --submit=true                 Ignored; records a retirement warning only
`);
}
