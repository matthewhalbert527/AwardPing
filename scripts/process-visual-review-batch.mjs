#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildVisualReviewPromptText,
  changeDetailsFromVisualBatchResult,
  expandableSectionCandidateRejectReason,
  fileToInlineGeminiPart,
  normalizeVisualBatchResult,
  stableJsonStringify,
  validateVisualBatchReview,
  visualHashFromCandidate,
  visualReviewResponseSchema,
} from "./lib/visual-review-queue.mjs";
import { sourceQualityDecision } from "./lib/source-quality.mjs";
import { enqueueAwardReconciliation } from "./lib/award-fact-reconciliation.mjs";
import {
  extractGeminiBatchInlineResponses,
  extractGeminiUsageMetadata,
  geminiBatchInlineResponseMap,
  geminiBatchJsonlRequest,
  geminiBatchOutputFileNames,
  geminiInlineError,
  geminiInlineResponsePayload,
} from "./lib/gemini-batch-support.mjs";
import { geminiWorkerModel } from "./lib/gemini-worker-policy.mjs";
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
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const geminiApiKey = env.GEMINI_API_KEY;
const limit = positiveInt(args.limit, 250);
const maxRequestsPerBatch = positiveInt(args["max-requests-per-batch"], 250);
const inlineThreshold = positiveInt(args["inline-threshold"], 100);
const poll = boolArg(args.poll, true);
const submit = boolArg(args.submit, true);
const apply = boolArg(args.apply, true);
const pollOnly = boolArg(args["poll-only"], false);
const submitOnly = boolArg(args["submit-only"], false);
const recoverMissingBatchResponses = boolArg(args["recover-missing-batch-responses"], true);
const requestTimeoutMs = positiveInt(args["request-timeout-ms"], 120_000);
const reportDir = args["report-dir"]
  ? resolve(root, String(args["report-dir"]))
  : join(root, "reports");
const runStamp = timestampForPath(new Date().toISOString());
const reportPath = args["report"]
  ? resolve(root, String(args.report))
  : join(reportDir, `visual-review-batch-${runStamp}.json`);
const jsonlDir = args["jsonl-dir"]
  ? resolve(root, String(args["jsonl-dir"]))
  : join(reportDir, "visual-review-batch-jsonl");
const model = geminiWorkerModel();

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

if (!geminiApiKey) {
  console.error("GEMINI_API_KEY is required to process visual review batches.");
  process.exit(1);
}

mkdirSync(reportDir, { recursive: true });
mkdirSync(jsonlDir, { recursive: true });

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
const report = {
  started_at: new Date().toISOString(),
  finished_at: null,
  status: "running",
  env_path: envPath,
  report_path: reportPath,
  options: {
    limit,
    max_requests_per_batch: maxRequestsPerBatch,
    inline_threshold: inlineThreshold,
    poll,
    submit,
    apply,
    recover_missing_batch_responses: recoverMissingBatchResponses,
  },
  pending_visual_reviews: 0,
  submitted_jobs: 0,
  submitted_candidates: 0,
  processing_jobs: 0,
  succeeded: 0,
  rejected: 0,
  failed: 0,
  published: 0,
  publish_duplicates: 0,
  superseded: 0,
  recovered_missing_batch_responses: 0,
  awards_queued_for_reconciliation: 0,
  award_reconciliation_queue_existing: 0,
  award_reconciliation_queue_failed: 0,
  estimated_batch_cost_usd: 0,
  actual_usage: emptyGeminiUsage(),
  batches: [],
  errors: [],
};

writeReport();

try {
  if (poll && !submitOnly) {
    await pollExistingBatches();
  }

  if (submit && !pollOnly) {
    await submitPendingCandidates();
  }

  await refreshStatusCounts();
  report.status = "succeeded";
} catch (error) {
  report.status = "failed";
  report.error = errorMessage(error);
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  writeReport();
  console.log(`VISUAL_REVIEW_BATCH_REPORT ${reportPath}`);
}

async function pollExistingBatches() {
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("gemini_batch_name,model,status,rejection_reason")
    .in("status", recoverMissingBatchResponses ? ["submitted", "processing", "failed"] : ["submitted", "processing"])
    .not("gemini_batch_name", "is", null)
    .limit(10_000);
  if (error) throw new Error(`Load submitted visual review batches failed: ${error.message}`);

  const batchNames = unique((data || [])
    .filter((row) => row.status !== "failed" || row.rejection_reason === "missing_batch_response")
    .map((row) => row.gemini_batch_name));
  for (const batchName of batchNames) {
    const job = await fetchGeminiJson(`https://generativelanguage.googleapis.com/v1beta/${batchName}`, {
      method: "GET",
      kind: "batch_poll",
    });
    const state = geminiBatchState(job);
    const batchReport = {
      name: batchName,
      state,
      reconciled: 0,
      rejected: 0,
      failed: 0,
      published: 0,
      mode: "poll",
    };
    report.batches.push(batchReport);

    if (!isGeminiBatchDone(state)) {
      report.processing_jobs += 1;
      await markBatchRowsProcessing(batchName);
      console.log(`VISUAL_REVIEW_BATCH processing job=${batchName} state=${state || "unknown"}`);
      continue;
    }

    if (!isGeminiBatchSucceeded(state)) {
      const message = geminiBatchErrorMessage(job);
      await markBatchRowsFailed(batchName, message);
      batchReport.failed += 1;
      report.failed += 1;
      console.log(`VISUAL_REVIEW_BATCH failed job=${batchName} state=${state} message=${truncate(message, 240)}`);
      continue;
    }

    await reconcileCompletedBatch(batchName, job, batchReport);
  }
}

async function submitPendingCandidates() {
  const { data, error, count } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("*", { count: "exact" })
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Load pending visual review candidates failed: ${error.message}`);

  report.pending_visual_reviews = count || 0;
  const candidates = data || [];
  if (!candidates.length) {
    console.log("VISUAL_REVIEW_BATCH no_pending_candidates");
    return;
  }

  const sourcesById = await loadSourcesById(candidates.map((candidate) => candidate.shared_award_source_id));
  const eligible = [];
  for (const candidate of candidates) {
    const source = sourcesById.get(candidate.shared_award_source_id);
    const rejectReason = preSubmissionRejectReason(candidate, source);
    if (rejectReason) {
      await markCandidate(candidate.id, {
        status: "rejected",
        rejection_reason: rejectReason,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      report.rejected += 1;
      continue;
    }
    eligible.push(candidate);
  }

  const byModel = groupBy(eligible, () => model);
  for (const [modelName, modelCandidates] of byModel) {
    for (const chunk of chunks(modelCandidates, maxRequestsPerBatch)) {
      await submitCandidateChunk(modelName, chunk);
    }
  }
}

async function submitCandidateChunk(model, candidates) {
  const requests = candidates.map((candidate) => geminiBatchRequestForCandidate(candidate));
  const mode = requests.length > inlineThreshold ? "jsonl_file" : "inline";
  const displayName = `awardping-visual-review-${timestampForPath(new Date().toISOString())}-${model.replace(/[^a-z0-9._-]+/gi, "-")}`;
  const batch = await createGeminiBatchJob({
    model,
    requests,
    displayName,
    mode,
  });
  const batchName = geminiBatchJobName(batch);
  if (!batchName) throw new Error(`Gemini batch creation did not return a batch name: ${JSON.stringify(batch).slice(0, 500)}`);

  const now = new Date().toISOString();
  const ids = candidates.map((candidate) => candidate.id);
  const { error } = await supabase
    .from("shared_award_visual_review_candidates")
    .update({
      status: "submitted",
      gemini_batch_name: batchName,
      model,
      submitted_at: now,
      updated_at: now,
      worker_metadata: {
        submitted_by: "process-visual-review-batch",
        submitted_at: now,
        batch_input_mode: mode,
        display_name: displayName,
      },
    })
    .in("id", ids);
  if (error) throw new Error(`Persist Gemini batch ${batchName} failed: ${error.message}`);

  report.submitted_jobs += 1;
  report.submitted_candidates += candidates.length;
  const estimated = candidates.reduce((total, candidate) => total + estimateCandidateBatchCostUsd(model, candidate), 0);
  report.estimated_batch_cost_usd = roundUsd(report.estimated_batch_cost_usd + estimated);
  report.batches.push({
    name: batchName,
    model,
    mode,
    submitted_candidates: candidates.length,
    estimated_cost_usd: roundUsd(estimated),
  });
  console.log(`VISUAL_REVIEW_BATCH submitted job=${batchName} model=${model} candidates=${candidates.length} mode=${mode}`);
}

async function reconcileCompletedBatch(batchName, job, batchReport) {
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("*")
    .eq("gemini_batch_name", batchName)
    .in("status", recoverMissingBatchResponses ? ["submitted", "processing", "succeeded", "failed"] : ["submitted", "processing", "succeeded"]);
  if (error) throw new Error(`Load visual review candidates for ${batchName} failed: ${error.message}`);

  const candidates = (data || []).filter((candidate) =>
    candidate.status !== "failed" || candidate.rejection_reason === "missing_batch_response"
  );
  const sourcesById = await loadSourcesById(candidates.map((candidate) => candidate.shared_award_source_id));
  const responseMap = await geminiBatchResponseMap(job);

  for (const candidate of candidates) {
    const recoveringMissingResponse = candidate.status === "failed" && candidate.rejection_reason === "missing_batch_response";
    const responseItem = responseMap.get(candidate.id) || responseMap.get(candidate.gemini_batch_request_key);
    if (!responseItem) {
      await markCandidate(candidate.id, {
        status: "failed",
        rejection_reason: "missing_batch_response",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      report.failed += 1;
      batchReport.failed += 1;
      continue;
    }

    if (recoveringMissingResponse) report.recovered_missing_batch_responses += 1;

    const itemError = geminiInlineError(responseItem);
    if (itemError) {
      await markCandidate(candidate.id, {
        status: "failed",
        rejection_reason: geminiInlineErrorMessage(itemError),
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      report.failed += 1;
      batchReport.failed += 1;
      continue;
    }

    const usage = normalizeGeminiUsage(extractUsageMetadata(responseItem));
    const rawText = extractGeminiText(geminiInlineResponsePayload(responseItem));
    let result;
    try {
      result = normalizeVisualBatchResult(rawText, {
        candidate,
        source: sourcesById.get(candidate.shared_award_source_id),
      });
    } catch (error) {
      await markCandidate(candidate.id, {
        status: "failed",
        ai_result: {
          raw_text: rawText,
          parse_error: errorMessage(error),
        },
        rejection_reason: `invalid_ai_json: ${errorMessage(error)}`,
        actual_usage: usage,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      report.failed += 1;
      batchReport.failed += 1;
      continue;
    }

    addUsage(report.actual_usage, usage);
    const source = sourcesById.get(candidate.shared_award_source_id);
    const publishResult = apply
      ? await publishCandidateResult({ candidate, source, result, usage })
      : await markCandidateSucceededDryRun({ candidate, result, usage });
    batchReport.reconciled += 1;
    if (publishResult.status === "published") {
      report.published += 1;
      batchReport.published += 1;
    } else if (publishResult.status === "duplicate") {
      report.publish_duplicates += 1;
    } else if (publishResult.status === "superseded") {
      report.superseded += 1;
    } else if (publishResult.status === "rejected") {
      report.rejected += 1;
      batchReport.rejected += 1;
    } else {
      report.succeeded += 1;
    }
  }
}

async function publishCandidateResult({ candidate, source, result, usage }) {
  const now = new Date().toISOString();
  if (!source) {
    await markCandidate(candidate.id, {
      status: "rejected",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: "missing_source",
      completed_at: now,
      updated_at: now,
    });
    return { status: "rejected", reason: "missing_source" };
  }

  if (source.admin_review_status && source.admin_review_status !== "open") {
    await markCandidate(candidate.id, {
      status: "rejected",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: `source_not_open_${source.admin_review_status}`,
      completed_at: now,
      updated_at: now,
    });
    return { status: "rejected", reason: "source_not_open" };
  }

  if (await hasNewerCandidate(candidate)) {
    await markCandidate(candidate.id, {
      status: "superseded",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: "newer_candidate_exists_for_source",
      completed_at: now,
      updated_at: now,
    });
    return { status: "superseded", reason: "newer_candidate_exists" };
  }

  const validation = validateVisualBatchReview({ candidate, source, result });
  if (!validation.allowed) {
    await markCandidate(candidate.id, {
      status: "rejected",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: validation.reason,
      completed_at: now,
      updated_at: now,
    });
    return { status: "rejected", reason: validation.reason };
  }

  const changeDetails = changeDetailsFromVisualBatchResult({
    candidate,
    source,
    result,
    model: candidate.model,
  });
  const previousHash = visualHashFromCandidate(candidate, "previous");
  const newHash = visualHashFromCandidate(candidate, "new");
  const { data, error } = await supabase
    .from("shared_award_change_events")
    .upsert(
      {
        shared_award_id: candidate.shared_award_id,
        shared_award_source_id: candidate.shared_award_source_id,
        source_url: source.url || candidate.source_url,
        source_title: source.title || candidate.source_title || null,
        source_page_type: source.page_type || candidate.source_page_type || null,
        previous_snapshot_id: null,
        new_snapshot_id: null,
        previous_hash: previousHash,
        new_hash: newHash,
        summary: changeDetails.reader_summary,
        change_details: changeDetails,
        detected_at: now,
      },
      {
        onConflict: "shared_award_id,source_url,previous_hash,new_hash",
        ignoreDuplicates: true,
      },
    )
    .select("id")
    .maybeSingle();

  if (error) {
    await markCandidate(candidate.id, {
      status: "failed",
      ai_result: result,
      actual_usage: usage,
      rejection_reason: `publish_failed: ${error.message}`,
      completed_at: now,
      updated_at: now,
    });
    throw new Error(`Publish visual review candidate ${candidate.id} failed: ${error.message}`);
  }

  await markCandidate(candidate.id, {
    status: "published",
    ai_result: result,
    actual_usage: usage,
    completed_at: now,
    published_at: now,
    updated_at: now,
  });

  if (data?.id) {
    await queueAwardReconciliationForCandidate({
      candidate,
      source,
      reason: "visual_change_published",
      candidateIds: [candidate.id],
      metadata: {
        change_event_id: data.id,
        batch_candidate_status: "published",
      },
    });
    return { status: "published", event_id: data.id };
  }

  return { status: "duplicate" };
}

async function queueAwardReconciliationForCandidate({
  candidate,
  source,
  reason,
  candidateIds = [],
  metadata = {},
}) {
  if (!candidate?.shared_award_id) return null;
  try {
    const result = await enqueueAwardReconciliation(supabase, {
      awardId: candidate.shared_award_id,
      reason,
      sourceIds: [source?.id || candidate.shared_award_source_id].filter(Boolean),
      candidateIds,
      priority: 70,
      metadata: {
        ...metadata,
        queued_by: "process-visual-review-batch",
        visual_candidate_id: candidate.id,
      },
    });
    if (result.queued) report.awards_queued_for_reconciliation += 1;
    else report.award_reconciliation_queue_existing += 1;
    return result;
  } catch (error) {
    report.award_reconciliation_queue_failed += 1;
    report.errors.push({
      candidate_id: candidate.id,
      source_id: candidate.shared_award_source_id,
      message: `Award reconciliation queue failed: ${errorMessage(error)}`,
    });
    return null;
  }
}

async function markCandidateSucceededDryRun({ candidate, result, usage }) {
  const now = new Date().toISOString();
  await markCandidate(candidate.id, {
    status: "succeeded",
    ai_result: result,
    actual_usage: usage,
    completed_at: now,
    rejection_reason: "apply_false_not_published",
    updated_at: now,
  });
  return { status: "succeeded", reason: "apply_false" };
}

function geminiBatchRequestForCandidate(candidate) {
  const promptPayload = candidate.prompt_payload || {};
  const promptText = candidate.prompt_context || buildVisualReviewPromptText(promptPayload);
  const parts = [{ text: promptText }];
  if (promptPayload.include_images) {
    for (const path of [
      promptPayload.previous_snapshot_ref?.local_paths?.thumb?.path,
      promptPayload.new_snapshot_ref?.local_paths?.thumb?.path,
    ]) {
      const imagePart = fileToInlineGeminiPart(path);
      if (imagePart) parts.push(imagePart);
    }
  }

  return {
    request: {
      systemInstruction: {
        parts: [
          {
            text: "You are a strict scholarship award source-change reviewer. Return JSON only. Reject all noise unless exact evidence supports an applicant-facing award fact change.",
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts,
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 900,
        responseMimeType: "application/json",
        responseSchema: visualReviewResponseSchema,
      },
    },
    metadata: {
      key: candidate.id,
      candidate_signature: candidate.candidate_signature,
    },
  };
}

async function createGeminiBatchJob({ model, requests, displayName, mode }) {
  if (mode === "jsonl_file") {
    const fileName = await uploadGeminiJsonlRequests({ requests, displayName });
    return fetchGeminiJson(geminiBatchUrl(model), {
      method: "POST",
      body: JSON.stringify({
        batch: {
          displayName,
          inputConfig: { fileName },
        },
      }),
      kind: "batch_create_file",
    });
  }

  return fetchGeminiJson(geminiBatchUrl(model), {
    method: "POST",
    body: JSON.stringify({
      batch: {
        displayName,
        inputConfig: {
          requests: { requests },
        },
      },
    }),
    kind: "batch_create_inline",
  });
}

async function uploadGeminiJsonlRequests({ requests, displayName }) {
  const path = join(jsonlDir, `${displayName}.jsonl`);
  const body = requests.map((request) => JSON.stringify(geminiBatchJsonlRequest(request))).join("\n") + "\n";
  writeFileSync(path, body, "utf8");
  const bytes = Buffer.from(body, "utf8");
  const startResponse = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(geminiApiKey)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(bytes.length),
        "x-goog-upload-header-content-type": "application/jsonl",
      },
      body: JSON.stringify({
        file: {
          display_name: displayName,
          mime_type: "application/jsonl",
        },
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    },
  );
  if (!startResponse.ok) {
    throw new Error(`Gemini file upload start failed: ${startResponse.status} ${await startResponse.text().catch(() => "")}`);
  }
  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini file upload did not return x-goog-upload-url.");

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "content-length": String(bytes.length),
      "x-goog-upload-offset": "0",
      "x-goog-upload-command": "upload, finalize",
    },
    body: bytes,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const uploadBody = await uploadResponse.text().catch(() => "");
  if (!uploadResponse.ok) {
    throw new Error(`Gemini file upload finalize failed: ${uploadResponse.status} ${uploadBody}`);
  }
  const parsed = parseJsonObject(uploadBody) || {};
  const fileName = parsed.file?.name || parsed.name;
  if (!fileName) throw new Error(`Gemini file upload did not return a file name: ${uploadBody.slice(0, 500)}`);
  return fileName;
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

async function fetchGeminiJson(url, { method, body, kind }) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": geminiApiKey,
        },
        body,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const responseBody = await response.text().catch(() => "");
      if (response.ok) return JSON.parse(responseBody);

      const message = geminiHttpErrorMessage(response.status, responseBody);
      if (attempt < maxAttempts && isRetryableGeminiFailure(response.status, responseBody)) {
        const waitMs = attempt * 1500;
        console.log(`GEMINI_RETRY kind=${kind} attempt=${attempt}/${maxAttempts} wait_ms=${waitMs} message=${truncate(message, 240)}`);
        await sleep(waitMs);
        continue;
      }
      throw new Error(message);
    } catch (error) {
      if (attempt < maxAttempts && isRetryableNetworkFailure(error)) {
        const waitMs = attempt * 1500;
        console.log(`GEMINI_RETRY kind=${kind} attempt=${attempt}/${maxAttempts} wait_ms=${waitMs} message=${truncate(errorMessage(error), 240)}`);
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Gemini request failed after ${maxAttempts} attempts.`);
}

async function loadSourcesById(ids) {
  const uniqueIds = unique(ids).filter(Boolean);
  const map = new Map();
  for (const idChunk of chunks(uniqueIds, 500)) {
    const { data, error } = await supabase
      .from("shared_award_sources")
      .select("id,shared_award_id,url,title,page_type,source,reason,page_metadata,page_metadata_generated_at,page_metadata_model,submitted_by_user_id,admin_review_status,shared_awards(name)")
      .in("id", idChunk);
    if (error) throw new Error(`Load shared award sources failed: ${error.message}`);
    for (const row of data || []) map.set(row.id, row);
  }
  return map;
}

async function hasNewerCandidate(candidate) {
  const { data, error } = await supabase
    .from("shared_award_visual_review_candidates")
    .select("id")
    .eq("shared_award_source_id", candidate.shared_award_source_id)
    .gt("created_at", candidate.created_at)
    .in("status", ["pending", "submitted", "processing", "succeeded", "published"])
    .limit(1);
  if (error) throw new Error(`Check superseded visual candidate failed: ${error.message}`);
  return Boolean((data || []).length);
}

function preSubmissionRejectReason(candidate, source) {
  if (!source) return "missing_source";
  if (source.admin_review_status && source.admin_review_status !== "open") return `source_not_open_${source.admin_review_status}`;
  const quality = sourceQualityDecision(source, { purpose: "monitoring" });
  if (!quality.allowed) return `source_quality_${quality.reason}`;
  const sectionRejectReason = expandableSectionCandidateRejectReason(candidate);
  if (sectionRejectReason) return sectionRejectReason;
  if (!candidate.prompt_context && !candidate.prompt_payload) return "missing_prompt_payload";
  return null;
}

async function markBatchRowsProcessing(batchName) {
  const { error } = await supabase
    .from("shared_award_visual_review_candidates")
    .update({
      status: "processing",
      updated_at: new Date().toISOString(),
    })
    .eq("gemini_batch_name", batchName)
    .eq("status", "submitted");
  if (error) throw new Error(`Mark visual batch processing failed: ${error.message}`);
}

async function markBatchRowsFailed(batchName, message) {
  const { error } = await supabase
    .from("shared_award_visual_review_candidates")
    .update({
      status: "failed",
      rejection_reason: message,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("gemini_batch_name", batchName)
    .in("status", ["submitted", "processing"]);
  if (error) throw new Error(`Mark visual batch failed failed: ${error.message}`);
}

async function markCandidate(id, patch) {
  const { error } = await supabase
    .from("shared_award_visual_review_candidates")
    .update(patch)
    .eq("id", id);
  if (error) throw new Error(`Update visual review candidate ${id} failed: ${error.message}`);
}

async function refreshStatusCounts() {
  const statuses = ["pending", "submitted", "processing", "succeeded", "rejected", "failed", "published", "superseded"];
  report.status_counts = {};
  for (const status of statuses) {
    const { count, error } = await supabase
      .from("shared_award_visual_review_candidates")
      .select("id", { count: "exact", head: true })
      .eq("status", status);
    if (error) throw new Error(`Count visual review candidates status=${status} failed: ${error.message}`);
    report.status_counts[status] = count || 0;
  }
}

function geminiBatchUrl(model) {
  const modelName = String(model || "").replace(/^models\//, "");
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:batchGenerateContent`;
}

function geminiBatchJobName(data) {
  return [
    data?.name,
    data?.metadata?.name,
    data?.response?.name,
    data?.response?.metadata?.name,
  ].find((value) => typeof value === "string" && value.startsWith("batches/")) || null;
}

function geminiBatchState(data) {
  return cleanText(
    data?.metadata?.state ||
      data?.response?.state ||
      data?.state ||
      data?.metadata?.batchState ||
      data?.metadata?.batch_state,
  );
}

function isGeminiBatchDone(state) {
  return new Set([
    "JOB_STATE_SUCCEEDED",
    "JOB_STATE_FAILED",
    "JOB_STATE_CANCELLED",
    "JOB_STATE_EXPIRED",
    "BATCH_STATE_SUCCEEDED",
    "BATCH_STATE_FAILED",
    "BATCH_STATE_CANCELLED",
    "BATCH_STATE_EXPIRED",
  ]).has(state);
}

function isGeminiBatchSucceeded(state) {
  return new Set(["JOB_STATE_SUCCEEDED", "BATCH_STATE_SUCCEEDED"]).has(state);
}

function geminiBatchErrorMessage(data) {
  return geminiInlineErrorMessage(data?.error || data?.response?.error || data?.metadata?.error);
}

function geminiInlineErrorMessage(error) {
  if (!error) return "No error details returned.";
  if (typeof error === "string") return error;
  return cleanText(error.message || error.status || JSON.stringify(error));
}

function extractGeminiText(data) {
  return (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || "")
    .join("\n")
    .trim();
}

function extractUsageMetadata(responseItem) {
  return extractGeminiUsageMetadata(responseItem);
}

function normalizeGeminiUsage(metadata) {
  return {
    prompt_tokens: nonNegativeInt(metadata?.promptTokenCount ?? metadata?.prompt_tokens, 0),
    candidates_tokens: nonNegativeInt(metadata?.candidatesTokenCount ?? metadata?.candidates_tokens, 0),
    total_tokens: nonNegativeInt(metadata?.totalTokenCount ?? metadata?.total_tokens, 0),
    thoughts_tokens: nonNegativeInt(metadata?.thoughtsTokenCount ?? metadata?.thoughts_tokens, 0),
    cached_content_tokens: nonNegativeInt(metadata?.cachedContentTokenCount ?? metadata?.cached_content_tokens, 0),
  };
}

function emptyGeminiUsage() {
  return {
    prompt_tokens: 0,
    candidates_tokens: 0,
    total_tokens: 0,
    thoughts_tokens: 0,
    cached_content_tokens: 0,
  };
}

function addUsage(target, usage) {
  target.prompt_tokens += usage.prompt_tokens || 0;
  target.candidates_tokens += usage.candidates_tokens || 0;
  target.total_tokens += usage.total_tokens || 0;
  target.thoughts_tokens += usage.thoughts_tokens || 0;
  target.cached_content_tokens += usage.cached_content_tokens || 0;
  return target;
}

function estimateCandidateBatchCostUsd(model, candidate) {
  const promptChars = String(candidate.prompt_context || stableJsonStringify(candidate.prompt_payload || {})).length;
  const estimatedInputTokens = Math.ceil(promptChars / 4);
  const estimatedOutputTokens = 800;
  const rates = geminiBatchPricePerMillion(model);
  return roundUsd((estimatedInputTokens / 1_000_000) * rates.input + (estimatedOutputTokens / 1_000_000) * rates.output);
}

function geminiBatchPricePerMillion(model) {
  const name = String(model || "").toLowerCase();
  if (name.includes("2.5-flash-lite")) return { input: 0.05, output: 0.2 };
  if (name.includes("2.5-flash")) return { input: 0.15, output: 1.25 };
  if (name.includes("3.1-flash-lite")) return { input: 0.125, output: 0.75 };
  if (name.includes("3-flash") || name.includes("3.1-flash")) return { input: 0.25, output: 1.5 };
  return { input: 0.5, output: 2.5 };
}

function geminiHttpErrorMessage(httpStatus, body) {
  const parsed = parseJsonObject(body) || {};
  const providerMessage = cleanNullable(objectValue(parsed.error).message);
  return `Gemini HTTP ${httpStatus}: ${truncate(providerMessage || body || "Gemini API request failed.", 800)}`;
}

function isRetryableGeminiFailure(httpStatus, body) {
  if ([408, 409, 429, 500, 502, 503, 504].includes(Number(httpStatus))) return true;
  return /(temporarily unavailable|try again|rate|quota|timeout|overloaded|high demand)/i.test(String(body || ""));
}

function isRetryableNetworkFailure(error) {
  return /(fetch failed|network|timeout|econnreset|etimedout|socket|temporarily unavailable)/i.test(errorMessage(error));
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const withoutPrefix = value.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) {
      parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[withoutPrefix] = next;
      index += 1;
    } else {
      parsed[withoutPrefix] = "true";
    }
  }
  return parsed;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
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

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanNullable(value) {
  const clean = cleanText(value);
  return clean || null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseJsonObject(text) {
  const clean = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (!clean) return null;
  try {
    const parsed = JSON.parse(clean);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function printHelp() {
  console.log(`Process Gemini Batch visual-review candidates.

Options:
  --limit=250
  --max-requests-per-batch=250
  --inline-threshold=100
  --poll=true
  --submit=true
  --poll-only=false
  --submit-only=false
  --apply=true
  --env=.env.worker.local
`);
}

function roundUsd(value) {
  return Math.round(Math.max(0, Number(value) || 0) * 1_000_000) / 1_000_000;
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeReport() {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
