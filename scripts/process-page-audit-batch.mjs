#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
const model = cleanNullable(args.model) || "gemini-2.5-flash-lite";
const apply = boolArg(args.apply, true);
const submit = boolArg(args.submit, true);
const poll = boolArg(args.poll, true);
const pollOnly = boolArg(args["poll-only"], false);
const submitOnly = boolArg(args["submit-only"], false);
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(reportDir, `page-audit-batch-${timestampForPath(new Date().toISOString())}.json`);
const requestTimeoutMs = positiveInt(args["request-timeout-ms"], 120_000);

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}
if (!geminiApiKey && (submit || poll)) {
  console.error("GEMINI_API_KEY is required to process page audit batches.");
  process.exit(1);
}

mkdirSync(reportDir, { recursive: true });
const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const report = {
  started_at: new Date().toISOString(),
  finished_at: null,
  status: "running",
  env_path: envPath,
  report_path: reportPath,
  options: { limit, max_requests_per_batch: maxRequestsPerBatch, model, apply, submit, poll },
  page_audit_batch_candidates: 0,
  submitted_jobs: 0,
  submitted_audits: 0,
  reconciled: 0,
  failed: 0,
  errors: [],
  batches: [],
};

writeReport();
try {
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
  const { data, error, count } = await supabase
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
  const audits = data || [];
  report.page_audit_batch_candidates = count || audits.length;
  for (const chunk of chunks(audits, maxRequestsPerBatch)) {
    await submitAuditChunk(chunk);
  }
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
        maxOutputTokens: 1400,
        responseMimeType: "application/json",
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

  if (apply) {
    const rows = audits.map((audit) => ({
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
    const { error } = await supabase.from("shared_award_page_audits").insert(rows);
    if (error) throw new Error(`Persist page audit batch rows failed: ${error.message}`);
  }

  report.submitted_jobs += 1;
  report.submitted_audits += audits.length;
  report.batches.push({ name: batchName, model, submitted_audits: audits.length });
}

function buildPrompt(audit) {
  return [
    "Audit this reconciled public award page. Default to needs_review when uncertain.",
    "Reject sibling sources, unsupported descriptions, invented dates, stale cycle states, rejected-source facts, vague materials, and generic listing facts.",
    "Apply suggestions only if supported by candidate ids, exact evidence quotes, or the supplied public page snapshot.",
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
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-goog-api-key": geminiApiKey },
    body,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`Gemini ${kind} failed: ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function geminiBatchResponseMap(job) {
  const responses = job?.response?.responses || job?.metadata?.responses || job?.responses || [];
  const map = new Map();
  for (const response of responses) {
    const key = response?.metadata?.key || response?.key || response?.request?.metadata?.key;
    if (key) map.set(key, response);
  }
  return map;
}

function geminiInlineResponsePayload(item) {
  return item?.response || item?.generateContentResponse || item;
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

function printHelp() {
  console.log(`Process Gemini Batch page audits for flagged AwardPing public pages.

Options:
  --limit=100
  --max-requests-per-batch=100
  --model=gemini-2.5-flash-lite
  --poll=true
  --submit=true
  --poll-only=false
  --submit-only=false
  --apply=true
`);
}
