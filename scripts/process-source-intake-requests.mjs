#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  baselineFactsFromIntakeReview,
  buildGeminiIntakeRequest,
  captureIntakePage,
  deterministicSourceIntakeReview,
  factCandidateRowsFromIntake,
  geminiInlineResponsePayload,
  matchSourceToExistingAward,
  normalizeGeminiIntakeResult,
  normalizeSharedAwardPageType,
  normalizeSourceIntakeUrl,
  parseJsonObject,
  sourceLikeFromIntake,
  sourceQualityForIntakeSource,
  shouldCreateNewAwardFromIntake,
  validateIntakeAiDecision,
} from "./lib/source-intake.mjs";
import { enqueueAwardReconciliation } from "./lib/award-fact-reconciliation.mjs";
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
const requestId = cleanNullable(args["request-id"]);
const statuses = csvList(args.status).length
  ? csvList(args.status)
  : ["pending", "queued", "failed"];
const dryRun = boolArg(args["dry-run"], !boolArg(args.apply, false));
const apply = boolArg(args.apply, !dryRun);
const geminiApiMode = cleanChoice(args["gemini-api-mode"], ["batch", "immediate", "none"], "batch");
const createAwards = boolArg(args["create-awards"], true);
const autoApproveThreshold = numberArg(args["auto-approve-threshold"], 0.85);
const manualReviewThreshold = numberArg(args["manual-review-threshold"], 0.55);
const submit = boolArg(args.submit, true);
const poll = boolArg(args.poll, true);
const pollOnly = boolArg(args["poll-only"], false);
const submitOnly = boolArg(args["submit-only"], false);
const model = cleanNullable(args.model) || "gemini-2.5-flash-lite";
const maxRequestsPerBatch = positiveInt(args["max-requests-per-batch"], 100);
const requestTimeoutMs = positiveInt(args["request-timeout-ms"], 120_000);
const captureTimeoutMs = positiveInt(args["capture-timeout-ms"], 30_000);
const reportDir = args["report-dir"] ? resolve(root, String(args["report-dir"])) : join(root, "reports");
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(reportDir, `source-intake-${timestampForPath(new Date().toISOString())}.json`);
const workerRunId = randomUUID();

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}
if (geminiApiMode !== "none" && (submit || poll) && !geminiApiKey) {
  console.error("GEMINI_API_KEY is required for source intake Gemini review.");
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
  worker_run_id: workerRunId,
  options: {
    limit,
    request_id: requestId,
    statuses,
    dry_run: dryRun,
    apply,
    gemini_api_mode: geminiApiMode,
    create_awards: createAwards,
    auto_approve_threshold: autoApproveThreshold,
    manual_review_threshold: manualReviewThreshold,
    model,
    max_requests_per_batch: maxRequestsPerBatch,
  },
  requests_loaded: 0,
  captured: 0,
  deterministic_rejected: 0,
  deterministic_manual_review: 0,
  ai_review_pending: 0,
  ai_review_submitted: 0,
  ai_review_succeeded: 0,
  ai_review_rejected: 0,
  needs_manual_review: 0,
  matched_existing_awards: 0,
  created_awards: 0,
  created_or_updated_sources: 0,
  fact_candidates_inserted: 0,
  awards_queued_for_reconciliation: 0,
  rejected: 0,
  failed: 0,
  batches: [],
  errors: [],
  requests: [],
};

const workerRun = await createWorkerRun().catch((error) => {
  console.warn(`SOURCE_INTAKE_WORKER_RUN_UNAVAILABLE ${errorMessage(error)}`);
  return null;
});

writeReport();
try {
  if (poll && !submitOnly && geminiApiMode === "batch") await pollSubmittedBatches();
  if (!pollOnly) await capturePendingRequests();
  if (submit && !pollOnly && geminiApiMode === "batch") await submitPendingAiRequests();
  report.status = report.errors.length ? "completed_with_errors" : "succeeded";
} catch (error) {
  report.status = "failed";
  report.errors.push({ message: errorMessage(error) });
  await syncWorkerRun("failed", errorMessage(error));
  throw error;
} finally {
  report.finished_at = new Date().toISOString();
  writeReport();
  await syncWorkerRun(report.status === "succeeded" ? "succeeded" : "failed", report.status === "succeeded" ? null : report.errors.at(-1)?.message || null);
  console.log(`SOURCE_INTAKE_REPORT ${reportPath}`);
}

async function capturePendingRequests() {
  const rows = await loadTargetRows();
  report.requests_loaded = rows.length;
  for (const row of rows) {
    await processCaptureStage(row);
    writeReport();
  }
}

async function loadTargetRows() {
  let query = supabase
    .from("source_page_requests")
    .select("*")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (requestId) query = query.eq("id", requestId);
  else query = query.in("status", statuses);
  const { data, error } = await query;
  if (error) throw new Error(`Load source intake requests failed: ${error.message}`);
  return data || [];
}

async function processCaptureStage(row) {
  const summary = {
    id: row.id,
    submitted_url: row.submitted_url || row.homepage_url,
    status: "processing",
    reason: null,
  };
  report.requests.push(summary);

  try {
    if (apply) await updateRequest(row.id, { status: "validating", worker_run_id: workerRunId, error: null, failed_at: null });
    const normalizedUrl = normalizeSourceIntakeUrl(row.normalized_url || row.homepage_url || row.submitted_url);
    if (apply) {
      await updateRequest(row.id, {
        normalized_url: normalizedUrl,
        homepage_url: normalizedUrl,
        submitted_url: row.submitted_url || row.homepage_url || normalizedUrl,
        status: "capturing",
      });
    }

    const capture = await captureIntakePage(normalizedUrl, { timeoutMs: captureTimeoutMs });
    report.captured += 1;
    const deterministicReview = deterministicSourceIntakeReview({
      url: capture.canonical_url || capture.final_url || normalizedUrl,
      title: capture.title,
      text: capture.text,
      requestedAwardName: row.award_name,
      contentType: capture.content_type,
    });
    summary.reason = deterministicReview.reason;

    const captureMetadata = {
      ...capture,
      text_excerpt: String(capture.text || "").slice(0, 20_000),
      text_length: String(capture.text || "").length,
      links: undefined,
      pdf_links: undefined,
    };
    const discoveredLinks = {
      links: capture.links || [],
      pdf_links: capture.pdf_links || [],
    };

    if (apply) {
      await updateRequest(row.id, {
        normalized_url: deterministicReview.normalizedUrl || capture.canonical_url || normalizedUrl,
        detected_award_name: row.detected_award_name || null,
        deterministic_review: deterministicReview,
        capture_metadata: captureMetadata,
        discovered_links: discoveredLinks,
      });
    }

    if (deterministicReview.status === "rejected") {
      report.deterministic_rejected += 1;
      report.rejected += 1;
      summary.status = "rejected";
      if (apply) {
        await updateRequest(row.id, {
          status: "rejected",
          status_reason: deterministicReview.reason,
          processed_at: new Date().toISOString(),
        });
      }
      return;
    }

    if (deterministicReview.status === "needs_manual_review") {
      report.deterministic_manual_review += 1;
      report.needs_manual_review += 1;
      summary.status = "needs_manual_review";
      if (apply) {
        await updateRequest(row.id, {
          status: "needs_manual_review",
          status_reason: deterministicReview.reason,
          processed_at: new Date().toISOString(),
        });
      }
      return;
    }

    if (geminiApiMode === "none") {
      report.needs_manual_review += 1;
      summary.status = "needs_manual_review";
      if (apply) {
        await updateRequest(row.id, {
          status: "needs_manual_review",
          status_reason: "gemini_review_disabled",
          processed_at: new Date().toISOString(),
        });
      }
      return;
    }

    if (geminiApiMode === "immediate") {
      const result = await runImmediateGemini(row, capture, deterministicReview);
      await finalizeReviewedRequest({ ...row, normalized_url: deterministicReview.normalizedUrl || normalizedUrl }, capture, deterministicReview, result);
      summary.status = "reviewed_immediate";
      return;
    }

    report.ai_review_pending += 1;
    summary.status = "ai_review_pending";
    if (apply) {
      await updateRequest(row.id, {
        status: "ai_review_pending",
        status_reason: "ready_for_gemini_batch_review",
      });
    }
  } catch (error) {
    report.failed += 1;
    summary.status = "failed";
    summary.reason = errorMessage(error);
    report.errors.push({ request_id: row.id, message: errorMessage(error) });
    if (apply) {
      await updateRequest(row.id, {
        status: "failed",
        status_reason: "source_intake_processing_failed",
        failed_at: new Date().toISOString(),
        error: errorMessage(error).slice(0, 1000),
      });
    }
  }
}

async function submitPendingAiRequests() {
  const { data, error } = await supabase
    .from("source_page_requests")
    .select("*")
    .eq("status", "ai_review_pending")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Load pending source intake AI reviews failed: ${error.message}`);

  const rows = data || [];
  for (const chunk of chunks(rows, maxRequestsPerBatch)) {
    await submitAiReviewChunk(chunk);
  }
}

async function submitAiReviewChunk(rows) {
  if (!rows.length) return;
  const requests = rows.map((row) => {
    const capture = captureFromRow(row);
    const deterministicReview = objectValue(row.deterministic_review);
    return buildGeminiIntakeRequest(row, capture, deterministicReview, model);
  });
  const displayName = `awardping-source-intake-${timestampForPath(new Date().toISOString())}-${model.replace(/[^a-z0-9._-]+/gi, "-")}`;
  const batch = await fetchGeminiJson(geminiBatchUrl(model), {
    method: "POST",
    body: JSON.stringify({ batch: { displayName, inputConfig: { requests: { requests } } } }),
    kind: "source_intake_batch_create",
  });
  const batchName = geminiBatchJobName(batch);
  if (!batchName) throw new Error(`Gemini source intake batch did not return a batch name: ${JSON.stringify(batch).slice(0, 500)}`);

  if (apply) {
    const now = new Date().toISOString();
    for (const row of rows) {
      await updateRequest(row.id, {
        status: "ai_review_submitted",
        status_reason: "submitted_to_gemini_batch",
        ai_review: {
          ...(objectValue(row.ai_review)),
          gemini_batch_name: batchName,
          gemini_batch_request_key: row.id,
          model,
          submitted_at: now,
          display_name: displayName,
        },
      });
    }
  }

  report.ai_review_submitted += rows.length;
  report.batches.push({ name: batchName, model, submitted_requests: rows.length, mode: "inline" });
}

async function pollSubmittedBatches() {
  const { data, error } = await supabase
    .from("source_page_requests")
    .select("id,ai_review")
    .eq("status", "ai_review_submitted")
    .limit(10_000);
  if (error) throw new Error(`Load submitted source intake batches failed: ${error.message}`);

  const batchNames = unique((data || []).map((row) => cleanNullable(objectValue(row.ai_review).gemini_batch_name)));
  for (const batchName of batchNames) {
    const job = await fetchGeminiJson(`https://generativelanguage.googleapis.com/v1beta/${batchName}`, {
      method: "GET",
      kind: "source_intake_batch_poll",
    });
    const state = geminiBatchState(job);
    const batchReport = { name: batchName, state, reconciled: 0, failed: 0, rejected: 0, mode: "poll" };
    report.batches.push(batchReport);
    if (!isGeminiBatchDone(state)) continue;
    if (!isGeminiBatchSucceeded(state)) {
      await markBatchRowsFailed(batchName, geminiBatchErrorMessage(job));
      batchReport.failed += 1;
      report.failed += 1;
      continue;
    }

    const responseMap = await geminiBatchResponseMap(job);
    const { data: rows, error: rowError } = await supabase
      .from("source_page_requests")
      .select("*")
      .eq("status", "ai_review_submitted")
      .filter("ai_review->>gemini_batch_name", "eq", batchName);
    if (rowError) throw new Error(`Load source intake rows for batch failed: ${rowError.message}`);

    for (const row of rows || []) {
      const responseItem = responseMap.get(row.id) || responseMap.get(cleanNullable(objectValue(row.ai_review).gemini_batch_request_key));
      if (!responseItem) {
        await updateRequest(row.id, {
          status: "failed",
          status_reason: "missing_gemini_batch_response",
          failed_at: new Date().toISOString(),
          error: "Gemini batch completed but no response was returned for this request.",
        });
        report.failed += 1;
        batchReport.failed += 1;
        continue;
      }
      const rawText = extractGeminiText(geminiInlineResponsePayload(responseItem));
      const parsed = parseJsonObject(rawText);
      if (!parsed) {
        await updateRequest(row.id, {
          status: "failed",
          status_reason: "invalid_gemini_intake_json",
          ai_review: { ...(objectValue(row.ai_review)), raw_text: rawText, parse_error: "invalid_json" },
          failed_at: new Date().toISOString(),
          error: "Gemini did not return valid intake JSON.",
        });
        report.failed += 1;
        batchReport.failed += 1;
        continue;
      }
      const capture = captureFromRow(row);
      const deterministicReview = objectValue(row.deterministic_review);
      await finalizeReviewedRequest(row, capture, deterministicReview, parsed);
      report.ai_review_succeeded += 1;
      batchReport.reconciled += 1;
    }
  }
}

async function finalizeReviewedRequest(row, capture, deterministicReview, rawResult) {
  const normalizedReview = normalizeGeminiIntakeResult(rawResult);
  const validation = validateIntakeAiDecision(normalizedReview);
  const now = new Date().toISOString();
  const aiReview = {
    ...(objectValue(row.ai_review)),
    ...normalizedReview,
    raw: rawResult,
    completed_at: now,
  };

  if (!validation.accepted) {
    const status = validation.manual ? "needs_manual_review" : "rejected";
    if (validation.manual) report.needs_manual_review += 1;
    else {
      report.ai_review_rejected += 1;
      report.rejected += 1;
    }
    if (apply) {
      await updateRequest(row.id, {
        status,
        status_reason: validation.reason,
        ai_review: aiReview,
        detected_award_name: normalizedReview.detected_award_name,
        detected_sponsor: normalizedReview.detected_sponsor,
        processed_at: now,
      });
    }
    return;
  }

  if (apply) {
    await updateRequest(row.id, {
      status: "matching",
      status_reason: "ai_review_accepted_matching_award",
      ai_review: aiReview,
      detected_award_name: normalizedReview.detected_award_name,
      detected_sponsor: normalizedReview.detected_sponsor,
    });
  }

  const awardResult = await resolveAwardForRequest(row, capture, deterministicReview, normalizedReview);
  if (!awardResult.award) {
    report.needs_manual_review += 1;
    if (apply) {
      await updateRequest(row.id, {
        status: "needs_manual_review",
        status_reason: awardResult.reason,
        ai_review: aiReview,
        processed_at: now,
      });
    }
    return;
  }

  const sourceLike = sourceLikeFromIntake({ request: row, capture, review: normalizedReview });
  sourceLike.shared_award_id = awardResult.award.id;
  const sourceQuality = sourceQualityForIntakeSource(sourceLike);
  if (!sourceQuality.allowed) {
    report.needs_manual_review += 1;
    if (apply) {
      await updateRequest(row.id, {
        status: "needs_manual_review",
        status_reason: `source_quality_${sourceQuality.reason}`,
        ai_review: aiReview,
        processed_at: now,
      });
    }
    return;
  }

  const source = apply
    ? await upsertAcceptedSource(awardResult.award.id, sourceLike, row)
    : { id: "dry-run-source-id" };
  report.created_or_updated_sources += 1;

  const candidateRows = factCandidateRowsFromIntake({
    awardId: awardResult.award.id,
    sourceId: source.id,
    sourceLike,
    review: normalizedReview,
  }).map((candidate) => ({
    ...candidate,
    metadata: {
      ...(objectValue(candidate.metadata)),
      source_page_request_id: row.id,
    },
  }));

  if (apply && candidateRows.length) {
    const { error } = await supabase.from("shared_award_fact_candidates").insert(candidateRows);
    if (error) throw new Error(`Insert intake fact candidates failed: ${error.message}`);
  }
  report.fact_candidates_inserted += candidateRows.length;

  if (apply) {
    const queueResult = await enqueueAwardReconciliation(supabase, {
      awardId: awardResult.award.id,
      reason: "source_intake_accepted",
      sourceIds: [source.id],
      priority: 35,
      metadata: {
        source_page_request_id: row.id,
        intake_review_status: normalizedReview.status,
        source_url: sourceLike.url,
      },
    });
    if (queueResult?.created) report.awards_queued_for_reconciliation += 1;
    await updateRequest(row.id, {
      status: "added",
      status_reason: awardResult.created ? "created_award_and_added_source" : "matched_award_and_added_source",
      matched_shared_award_id: awardResult.created ? null : awardResult.award.id,
      created_shared_award_id: awardResult.created ? awardResult.award.id : null,
      created_source_ids: [source.id],
      ai_review: aiReview,
      processed_at: now,
      error: null,
    });
  }
}

async function resolveAwardForRequest(row, capture, deterministicReview, review) {
  if (row.matched_shared_award_id) {
    const award = await loadAward(row.matched_shared_award_id);
    if (award) {
      report.matched_existing_awards += 1;
      return { award, created: false, reason: "manual_matched_award" };
    }
  }

  const awards = await loadExistingAwards();
  const match = matchSourceToExistingAward({ awards, request: row, capture, review });
  if (match?.award && match.score >= autoApproveThreshold) {
    report.matched_existing_awards += 1;
    return { award: match.award, created: false, reason: `matched_existing_award_${match.score.toFixed(2)}` };
  }
  if (match?.award && match.score >= manualReviewThreshold) {
    return { award: null, created: false, reason: `possible_existing_award_match_${match.score.toFixed(2)}` };
  }

  const createDecision = shouldCreateNewAwardFromIntake({
    review,
    deterministicReview,
    request: row,
    capture,
    threshold: autoApproveThreshold,
  });
  if (!createAwards || !createDecision.create) {
    return { award: null, created: false, reason: createDecision.reason };
  }

  if (!apply) {
    return {
      award: {
        id: "dry-run-award-id",
        name: review.detected_award_name || row.award_name,
        slug: null,
        official_homepage: capture.canonical_url || capture.final_url || row.normalized_url || row.homepage_url,
        summary: review.facts?.description || capture.page_description || null,
        confidence: 0.85,
        status: "active",
      },
      created: true,
      reason: "dry_run_create_new_award",
    };
  }

  const award = await createSharedAwardFromIntake(row, capture, review);
  report.created_awards += 1;
  return { award, created: true, reason: "created_new_award" };
}

async function loadExistingAwards() {
  const { data, error } = await supabase
    .from("shared_awards")
    .select("id,name,slug,official_homepage,summary,confidence,status")
    .eq("status", "active")
    .limit(20_000);
  if (error) throw new Error(`Load shared awards failed: ${error.message}`);
  return data || [];
}

async function loadAward(id) {
  const { data, error } = await supabase
    .from("shared_awards")
    .select("id,name,slug,official_homepage,summary,confidence,status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Load matched award failed: ${error.message}`);
  return data;
}

async function createSharedAwardFromIntake(row, capture, review) {
  const normalized = normalizeGeminiIntakeResult(review);
  const name = normalized.detected_award_name || row.award_name;
  const url = capture.canonical_url || capture.final_url || row.normalized_url || row.homepage_url;
  const searchKey = normalizeSharedAwardKey(name);
  const slug = slugify(name);
  const { data, error } = await supabase
    .from("shared_awards")
    .upsert({
      search_key: searchKey,
      name,
      slug,
      official_homepage: url,
      summary: normalized.facts.description || capture.page_description || null,
      public_facts: {},
      confidence: 0.85,
      status: "active",
      source: "admin",
    }, { onConflict: "search_key" })
    .select("id,name,slug,official_homepage,summary,confidence,status")
    .maybeSingle();
  if (error) throw new Error(`Create shared award failed: ${error.message}`);
  if (!data) throw new Error("Create shared award did not return a row.");
  return data;
}

async function upsertAcceptedSource(awardId, sourceLike, row) {
  const baselineFacts = baselineFactsFromIntakeReview(objectValue(sourceLike.page_metadata).intake_review || objectValue(row.ai_review));
  const { data, error } = await supabase
    .from("shared_award_sources")
    .upsert({
      shared_award_id: awardId,
      url: sourceLike.url,
      title: sourceLike.title,
      display_title: sourceLike.display_title || null,
      page_description: sourceLike.page_description || null,
      page_type: normalizeSharedAwardPageType(sourceLike.page_type),
      confidence: sourceLike.confidence || 0.75,
      reason: "Accepted through source intake workflow",
      source: "admin",
      submitted_by_user_id: row.user_id || null,
      admin_review_status: "open",
      page_metadata: {
        ...(objectValue(sourceLike.page_metadata)),
        baseline_facts: baselineFacts,
        source_intake_request_id: row.id,
      },
      page_metadata_generated_at: new Date().toISOString(),
      page_metadata_model: sourceLike.page_metadata_model || model,
      last_error: null,
      consecutive_failures: 0,
    }, { onConflict: "shared_award_id,url" })
    .select("id,shared_award_id,url,title")
    .maybeSingle();
  if (error) throw new Error(`Upsert accepted source failed: ${error.message}`);
  if (!data) throw new Error("Upsert accepted source did not return a row.");
  return data;
}

async function runImmediateGemini(row, capture, deterministicReview) {
  const request = buildGeminiIntakeRequest(row, capture, deterministicReview, model).request;
  const payload = await fetchGeminiJson(geminiGenerateUrl(model), {
    method: "POST",
    body: JSON.stringify(request),
    kind: "source_intake_immediate_review",
  });
  const rawText = extractGeminiText(payload);
  const parsed = parseJsonObject(rawText);
  if (!parsed) throw new Error("Gemini immediate review returned invalid JSON.");
  return parsed;
}

async function markBatchRowsFailed(batchName, message) {
  const { error } = await supabase
    .from("source_page_requests")
    .update({
      status: "failed",
      status_reason: "gemini_batch_failed",
      failed_at: new Date().toISOString(),
      error: message.slice(0, 1000),
    })
    .eq("status", "ai_review_submitted")
    .filter("ai_review->>gemini_batch_name", "eq", batchName);
  if (error) throw new Error(`Mark source intake batch failed failed: ${error.message}`);
}

async function createWorkerRun() {
  if (!apply) return null;
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      id: workerRunId,
      worker_name: "source-intake-processor",
      status: "running",
      ai_provider: geminiApiMode === "none" ? null : "gemini",
      metadata: workerMetadata(),
    })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function syncWorkerRun(status = "running", error = null) {
  if (!apply || !workerRun) return;
  const finished = status === "succeeded" || status === "failed";
  const { error: updateError } = await supabase
    .from("local_worker_runs")
    .update({
      status,
      checked_count: report.requests_loaded,
      changed_count: report.created_or_updated_sources,
      unchanged_count: report.needs_manual_review,
      initial_count: report.ai_review_pending,
      discovered_count: report.created_awards,
      failed_count: report.failed,
      error,
      metadata: workerMetadata(),
      finished_at: finished ? report.finished_at || new Date().toISOString() : null,
    })
    .eq("id", workerRunId);
  if (updateError) console.warn(`SOURCE_INTAKE_WORKER_SYNC_FAILED ${updateError.message}`);
}

function workerMetadata() {
  return {
    kind: "source_intake",
    report_path: reportPath,
    env_path: envPath,
    options: report.options,
    status: report.status,
    counters: {
      requests_loaded: report.requests_loaded,
      captured: report.captured,
      deterministic_rejected: report.deterministic_rejected,
      ai_review_pending: report.ai_review_pending,
      ai_review_submitted: report.ai_review_submitted,
      ai_review_succeeded: report.ai_review_succeeded,
      needs_manual_review: report.needs_manual_review,
      matched_existing_awards: report.matched_existing_awards,
      created_awards: report.created_awards,
      created_or_updated_sources: report.created_or_updated_sources,
      fact_candidates_inserted: report.fact_candidates_inserted,
      awards_queued_for_reconciliation: report.awards_queued_for_reconciliation,
    },
    batches: report.batches,
    updated_at: new Date().toISOString(),
  };
}

async function updateRequest(id, patch) {
  if (!apply) return;
  const { error } = await supabase
    .from("source_page_requests")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`Update source intake request failed: ${error.message}`);
}

function captureFromRow(row) {
  const capture = objectValue(row.capture_metadata);
  const links = objectValue(row.discovered_links);
  return {
    ...capture,
    final_url: cleanNullable(capture.final_url) || row.normalized_url || row.homepage_url,
    canonical_url: cleanNullable(capture.canonical_url) || row.normalized_url || row.homepage_url,
    title: cleanNullable(capture.title) || row.award_name,
    page_description: cleanNullable(capture.page_description),
    text: cleanNullable(capture.text) || cleanNullable(capture.text_excerpt),
    links: Array.isArray(links.links) ? links.links : [],
    pdf_links: Array.isArray(links.pdf_links) ? links.pdf_links : [],
  };
}

function geminiBatchUrl(value) {
  const modelName = String(value || "").replace(/^models\//, "");
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:batchGenerateContent`;
}

function geminiGenerateUrl(value) {
  const modelName = String(value || "").replace(/^models\//, "");
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
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
  return cleanNullable(job?.error?.message || job?.metadata?.error?.message || job?.response?.error?.message) || "Gemini source intake batch failed.";
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || payload?.response?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || "").join("\n").trim();
}

function writeReport() {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}

function printHelp() {
  console.log(`Usage: node scripts/process-source-intake-requests.mjs [options]

Options:
  --limit=100
  --request-id=<uuid>
  --status=pending,failed,needs_manual_review
  --apply=true|false
  --dry-run=true|false
  --gemini-api-mode=batch|immediate|none
  --create-awards=true|false
  --auto-approve-threshold=0.85
  --manual-review-threshold=0.55
  --poll=true|false
  --submit=true|false
  --poll-only=true
  --submit-only=true
`);
}

function normalizeSharedAwardKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value) {
  return normalizeSharedAwardKey(value).replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160) || `award-${Date.now()}`;
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

function csvList(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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

function numberArg(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanChoice(value, choices, fallback) {
  const key = String(value || "").trim().toLowerCase();
  return choices.includes(key) ? key : fallback;
}

function cleanNullable(value) {
  const text = String(value || "").trim();
  return text || null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
