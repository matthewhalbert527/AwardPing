#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runGeminiCliJsonAnalysis } from "./lib/gemini-cli-analysis.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const defaultArchiveRoot = "D:\\AwardPingVisualSnapshots";
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const archiveRoot = resolve(
  String(env.AWARDPING_VISUAL_SNAPSHOT_DIR || args["archive-dir"] || defaultArchiveRoot),
);
const detailsRoot = resolve(
  String(args["details-dir"] || env.AWARDPING_AWARD_DETAIL_DIR || join(archiveRoot, "award-details")),
);
const geminiCliPath = cleanText(
  args["gemini-cli-path"] ||
    env.AWARDPING_GEMINI_CLI_PATH ||
    env.GEMINI_CLI_PATH ||
    (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "agy", "bin", "agy.exe") : "agy"),
);
const geminiCliModel = cleanText(
    args["gemini-cli-model"] ||
    env.AWARDPING_AWARD_DETAIL_GEMINI_CLI_MODEL ||
    env.AWARDPING_GEMINI_CLI_MODEL ||
    "Gemini 3.5 Flash (Low)",
);
const geminiCliWorkspaceRoot = resolve(
  String(
    args["gemini-cli-workspace"] ||
      env.AWARDPING_GEMINI_CLI_WORKSPACE ||
      join(archiveRoot, "gemini-cli-workspace", "award-details"),
  ),
);
const geminiCliTimeoutMs = positiveInt(
  args["gemini-cli-timeout-ms"] || env.AWARDPING_AWARD_DETAIL_GEMINI_CLI_TIMEOUT_MS,
  150_000,
);
const geminiCliMaxCalls = nonNegativeInt(
  args["gemini-cli-max-calls"] || args["max-calls"] || env.AWARDPING_AWARD_DETAIL_GEMINI_CLI_MAX_CALLS,
  150,
);
const geminiCliSafeModels = listArg(
  args["gemini-cli-safe-models"] || env.AWARDPING_SAFE_GEMINI_CLI_MODELS,
  ["Gemini 3.5 Flash (Low)"],
);
const allowUnsafeGeminiCliModel = boolArg(
  args["allow-unsafe-gemini-cli-model"] ?? env.AWARDPING_ALLOW_UNSAFE_GEMINI_CLI_MODEL,
  false,
);
const limit = limitArg(args.limit, "all");
const awardIdFilter = cleanText(args["award-id"]);
const awardFilter = cleanText(args.award);
const applyUpdates = boolArg(args.apply, true);
const force = boolArg(args.force, false);
const skipExisting = boolArg(args["skip-existing"], true);
const sourceImagesPerAward = boundedInt(args["source-images-per-award"], 0, 0, 6);
const maxSourcesPerAward = boundedInt(args["max-sources-per-award"], 4, 1, 20);
const sourceTextChars = positiveInt(args["source-text-chars"], 2_500);
const totalTextChars = positiveInt(args["total-text-chars"], 10_000);
const heartbeatMinutes = positiveInt(args["heartbeat-minutes"], 5);

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

if (!geminiCliPath) {
  console.error("AWARDPING_GEMINI_CLI_PATH must point to agy.exe.");
  process.exit(1);
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);

async function runOnce() {
  mkdirSync(detailsRoot, { recursive: true });
  mkdirSync(geminiCliWorkspaceRoot, { recursive: true });

  const startedAt = new Date().toISOString();
  const runStamp = timestampForPath(startedAt);
  const reportPath = join(root, "reports", `award-baseline-details-${runStamp}.json`);
  const currentJsonlPath = join(detailsRoot, "award-details-current.jsonl");
  const report = {
    archive_root: archiveRoot,
    details_root: detailsRoot,
    started_at: startedAt,
    finished_at: null,
    status: "running",
    ai_provider: "gemini-cli",
    ai_model: geminiCliModel,
    env_path: envPath,
    options: {
      limit,
      award_id: awardIdFilter || null,
      award: awardFilter || null,
      apply: applyUpdates,
      force,
      skip_existing: skipExisting,
      gemini_cli_model: geminiCliModel,
      gemini_cli_safe_models: geminiCliSafeModels,
      allow_unsafe_gemini_cli_model: allowUnsafeGeminiCliModel,
      gemini_cli_max_calls: geminiCliMaxCalls || null,
      source_images_per_award: sourceImagesPerAward,
      max_sources_per_award: maxSourcesPerAward,
      source_text_chars: sourceTextChars,
      total_text_chars: totalTextChars,
    },
    loaded_awards: 0,
    checked: 0,
    extracted: 0,
    applied: 0,
    skipped_existing: 0,
    no_baseline: 0,
    failed: 0,
    gemini_cli_usage: {
      calls: 0,
      successes: 0,
      failures: 0,
      image_files: 0,
      view_file_calls: 0,
      stream_calls: 0,
      elapsed_ms: 0,
      model: geminiCliModel,
      note: "Gemini CLI / Antigravity does not expose exact token or account quota usage in worker logs.",
    },
    errors: [],
    saved_detail_paths: [],
  };

  const heartbeat = startHeartbeat(report);
  let workerRunId = null;

  try {
    workerRunId = await startWorkerRun(report);
    const awards = await loadAwards(limit);
    report.loaded_awards = awards.length;
    const sourcesByAward = await loadSourcesByAward(awards.map((award) => award.id));
    await updateWorkerRun(workerRunId, report);

    console.log(
      `DETAIL_RUN loaded_awards=${awards.length} model="${geminiCliModel}" apply=${applyUpdates} max_calls=${geminiCliMaxCalls || "none"}`,
    );

    for (const award of awards) {
      if (!geminiCliCallAvailable(report)) {
        console.log(`DETAIL_RUN stopping_at_call_cap calls=${report.gemini_cli_usage.calls}`);
        break;
      }

      const detailPath = awardDetailPath(award.id);
      if (!force && skipExisting && existingDetailSucceeded(detailPath)) {
        report.skipped_existing += 1;
        continue;
      }

      report.checked += 1;
      try {
        const sources = sourcesByAward.get(award.id) || [];
        const evidence = collectAwardEvidence(award, sources);
        if (evidence.baselines.length === 0) {
          report.no_baseline += 1;
          const message = "No local screenshot/PDF baseline is available for this award yet.";
          await markAwardFailed(award, message, detailPath, report);
          console.log(`DETAIL no_baseline ${award.name}`);
          continue;
        }

        const analysis = await runGeminiCliJsonAnalysis({
          cliPath: geminiCliPath,
          model: geminiCliModel,
          workspaceRoot: geminiCliWorkspaceRoot,
          timeoutMs: geminiCliTimeoutMs,
          safeModels: geminiCliSafeModels,
          allowUnsafeModel: allowUnsafeGeminiCliModel,
          runId: `award-${safePathSegment(award.id)}-${runStamp}`,
          prompt: awardDetailPrompt(award, evidence),
          filePaths: evidence.imagePaths,
        });
        recordGeminiCliUsage(report, analysis, true);

        const details = normalizeAwardDetails(analysis.result);
        const websiteSummary = buildWebsiteSummary(award, details);
        const saved = {
          version: 1,
          status: "succeeded",
          generated_at: new Date().toISOString(),
          provider: "gemini-cli",
          model: geminiCliModel,
          award: {
            id: award.id,
            name: award.name,
            official_homepage: award.official_homepage,
          },
          details,
          website_summary: websiteSummary,
          evidence: evidence.summary,
          usage: analysis.usage,
          analysis: {
            workspace_dir: analysis.workspace_dir,
            prompt_path: analysis.prompt_path,
            log_path: analysis.log_path,
            transcript_path: analysis.transcript_path,
            conversation_db_path: analysis.conversation_db_path,
          },
        };
        writeJson(detailPath, saved);
        appendFileSync(currentJsonlPath, `${JSON.stringify(saved)}\n`, "utf8");

        report.extracted += 1;
        report.saved_detail_paths.push(toArchiveRelative(detailPath));

        if (applyUpdates) {
          await updateAwardSummary(award, details, websiteSummary);
          report.applied += 1;
        }

        console.log(
          `DETAIL extracted confidence=${details.confidence} sources=${evidence.baselines.length} ${award.name}`,
        );
      } catch (error) {
        if (error.geminiCliUsage) recordGeminiCliUsage(report, { usage: error.geminiCliUsage }, false);
        report.failed += 1;
        const message = errorMessage(error);
        report.errors.push({ award_id: award.id, award_name: award.name, message });
        writeJson(detailPath, {
          version: 1,
          status: "failed",
          generated_at: new Date().toISOString(),
          provider: "gemini-cli",
          model: geminiCliModel,
          award: {
            id: award.id,
            name: award.name,
            official_homepage: award.official_homepage,
          },
          error: message,
        });
        await updateAwardFailure(award.id, message).catch((updateError) => {
          console.log(`DETAIL failure_update_failed ${award.name} | ${errorMessage(updateError)}`);
        });
        console.log(`DETAIL failed ${award.name} | ${message}`);
      }

      await maybeUpdateWorkerRun(workerRunId, report);
    }

    report.status = "succeeded";
    report.finished_at = new Date().toISOString();
    writeJson(join(detailsRoot, "award-details-latest-run.json"), report);
    await finishWorkerRun(workerRunId, "succeeded", null, report);
  } catch (error) {
    report.status = "failed";
    report.finished_at = new Date().toISOString();
    report.errors.push({ award_id: null, award_name: null, message: errorMessage(error) });
    await finishWorkerRun(workerRunId, "failed", errorMessage(error), report).catch(() => null);
    throw error;
  } finally {
    clearInterval(heartbeat);
    report.finished_at ||= new Date().toISOString();
    mkdirSync(dirname(reportPath), { recursive: true });
    writeJson(reportPath, report);
    writeJson(join(detailsRoot, "award-details-latest-run.json"), report);
    console.log(`REPORT ${reportPath}`);
  }
}

async function loadAwards(pageLimit) {
  const pageSize = 1_000;
  const awards = [];
  const maxRows = pageLimit === "all" ? Number.POSITIVE_INFINITY : pageLimit;

  for (let from = 0; awards.length < maxRows; from += pageSize) {
    const to = from + Math.min(pageSize, maxRows - awards.length) - 1;
    let query = supabase
      .from("shared_awards")
      .select(
        "id, search_key, name, official_homepage, summary, confidence, status, last_structure_scan_at, next_structure_scan_at, created_at, updated_at",
      )
      .eq("status", "active")
      .order("name", { ascending: true })
      .range(from, to);

    if (awardIdFilter) query = query.eq("id", awardIdFilter);
    if (awardFilter) query = query.ilike("name", `%${escapeLike(awardFilter)}%`);

    const { data, error } = await query;
    if (error) throw new Error(describeSupabaseError(error, "load shared awards"));

    const page = data || [];
    awards.push(...page);
    if (page.length < to - from + 1) break;
  }

  return awards.slice(0, maxRows);
}

async function loadSourcesByAward(awardIds) {
  const grouped = new Map();
  for (const awardId of awardIds) grouped.set(awardId, []);

  const pageSize = 1_000;
  for (const chunk of chunks(awardIds, 500)) {
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from("shared_award_sources")
        .select(
          "id, shared_award_id, url, title, page_type, confidence, last_checked_at, last_error, created_at",
        )
        .in("shared_award_id", chunk)
        .eq("admin_review_status", "open")
        .order("page_type", { ascending: true })
        .order("created_at", { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) throw new Error(describeSupabaseError(error, "load shared award sources"));

      const page = data || [];
      for (const source of page) {
        if (!grouped.has(source.shared_award_id)) grouped.set(source.shared_award_id, []);
        grouped.get(source.shared_award_id).push(source);
      }
      if (page.length < pageSize) break;
    }
  }

  return grouped;
}

function collectAwardEvidence(award, sources) {
  const baselines = sources
    .map((source) => ({ source, baseline: readJsonIfExists(baselinePathForSource(source.id)) }))
    .filter((entry) => entry.baseline)
    .sort((left, right) => sourcePriority(left.source) - sourcePriority(right.source));

  const selected = baselines.slice(0, maxSourcesPerAward);
  const imagePaths = [];
  const sourceSummaries = [];
  let remainingChars = totalTextChars;

  for (const entry of selected) {
    const evidence = readBaselineEvidence(entry.baseline);
    if (!evidence.ok) continue;

    if (imagePaths.length < sourceImagesPerAward && evidence.thumbPath) {
      imagePaths.push(evidence.thumbPath);
    }

    const textBudget = Math.min(sourceTextChars, Math.max(0, remainingChars));
    remainingChars -= textBudget;
    sourceSummaries.push({
      source_id: entry.source.id,
      title: entry.source.title,
      url: entry.source.url,
      page_type: entry.source.page_type,
      captured_at: entry.baseline.captured_at || null,
      kind: entry.baseline.kind || "webpage",
      page_title: entry.baseline.page_title || null,
      final_url: entry.baseline.final_url || null,
      text_excerpt: normalizeVisibleText(evidence.text).slice(0, textBudget),
      existing_baseline_facts: entry.baseline.summary_metadata?.baseline_facts || null,
    });
  }

  return {
    baselines: selected,
    imagePaths,
    summary: {
      award_id: award.id,
      award_name: award.name,
      source_count: sources.length,
      baseline_count: baselines.length,
      selected_sources: sourceSummaries.map((source) => ({
        source_id: source.source_id,
        title: source.title,
        url: source.url,
        page_type: source.page_type,
        captured_at: source.captured_at,
        kind: source.kind,
      })),
      image_count: imagePaths.length,
    },
    sourceSummaries,
  };
}

function awardDetailPrompt(award, evidence) {
  return [
    "You are extracting baseline award details for AwardPing from official source page text captured during screenshot/PDF baseline scans.",
    "Use source text excerpts as primary evidence. If images are provided, use them only to confirm visible facts.",
    "Extract only facts directly supported by the provided screenshots/text. Do not guess unknown dates, amounts, eligibility, or requirements.",
    "Prefer facts about the award itself over website navigation, news, cookie banners, unrelated programs, or generic organization copy.",
    "Return exactly one compact JSON object with these keys:",
    "{status, summary, deadline, opening_date, award_amounts, eligibility, requirements, application_materials, how_to_apply, important_dates, documents, contacts, notes, sources_used, confidence, quality_flags}",
    "status must be succeeded or insufficient_evidence. summary must be one plain-English sentence for advisors.",
    "Use arrays for award_amounts, eligibility, requirements, application_materials, how_to_apply, important_dates, documents, contacts, notes, sources_used, quality_flags.",
    "Every important_dates item must include context plus the date, such as \"Application deadline: January 15, 2027\" or \"Award notifications: May 1\". Do not output bare dates.",
    "Use null for unknown deadline or opening_date. confidence must be low, medium, or high.",
    "sources_used array items should be compact strings naming the source title or URL that supported important facts.",
    "",
    `Award name: ${award.name}`,
    `Official homepage: ${award.official_homepage || "unknown"}`,
    "",
    "Source evidence:",
    JSON.stringify(evidence.sourceSummaries),
  ].join("\n");
}

function normalizeAwardDetails(value) {
  const parsed = jsonObjectOrEmpty(value);
  return {
    status: ["succeeded", "insufficient_evidence"].includes(cleanSlug(parsed.status))
      ? cleanSlug(parsed.status)
      : "succeeded",
    summary: cleanNullable(parsed.summary),
    deadline: cleanNullable(parsed.deadline || parsed.deadline_date),
    opening_date: cleanNullable(parsed.opening_date || parsed.opens_at || parsed.application_opens),
    award_amounts: stringArray(parsed.award_amounts || parsed.amounts || parsed.funding).slice(0, 12),
    eligibility: stringArray(parsed.eligibility).slice(0, 20),
    requirements: stringArray(parsed.requirements).slice(0, 24),
    application_materials: stringArray(parsed.application_materials || parsed.materials).slice(0, 20),
    how_to_apply: stringArray(parsed.how_to_apply || parsed.application_instructions).slice(0, 20),
    important_dates: stringArray(parsed.important_dates || parsed.dates).slice(0, 16),
    documents: stringArray(parsed.documents || parsed.pdfs || parsed.pdf_links).slice(0, 20),
    contacts: stringArray(parsed.contacts || parsed.contact_info).slice(0, 12),
    notes: stringArray(parsed.notes).slice(0, 12),
    sources_used: stringArray(parsed.sources_used || parsed.sources).slice(0, 12),
    confidence: normalizeConfidence(parsed.confidence) || "low",
    quality_flags: stringArray(parsed.quality_flags).map(cleanSlug).filter(Boolean).slice(0, 20),
  };
}

function buildWebsiteSummary(award, details) {
  const parts = [];
  const summary =
    stripUrls(details.summary) ||
    `${award.name} has baseline details extracted from current AwardPing source snapshots.`;
  parts.push(ensureSentencePunctuation(summary));
  addFact(parts, "Deadline", details.deadline);
  addFact(parts, "Opening date", details.opening_date);
  addFact(parts, "Award amount", details.award_amounts);
  addFact(parts, "Eligibility", details.eligibility);
  addFact(parts, "Requirements", details.requirements);
  addFact(parts, "Application materials", details.application_materials);
  addFact(parts, "How to apply", details.how_to_apply);
  addFact(parts, "Important dates", details.important_dates);
  addFact(parts, "Documents", details.documents);
  addFact(parts, "Contacts", details.contacts);
  addFact(parts, "Notes", details.notes);
  parts.push(`Baseline detail confidence: ${details.confidence}.`);
  return truncate(parts.filter(Boolean).join(" "), 2_800);
}

function addFact(parts, label, value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const cleanValues = values
    .map((item) => cleanText(stripUrls(item)).replace(/[.;:\s]+$/g, ""))
    .filter(Boolean);
  if (!cleanValues.length) return;
  parts.push(`${label}: ${truncate(cleanValues.join("; "), 500)}.`);
}

function stripUrls(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function updateAwardSummary(award, details, websiteSummary) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("shared_awards")
    .update({
      summary: websiteSummary,
      confidence: confidenceScore(details.confidence),
      last_structure_scan_at: now,
      structure_scan_error: null,
      updated_at: now,
    })
    .eq("id", award.id);

  if (error) throw new Error(describeSupabaseError(error, "update award baseline details"));
}

async function markAwardFailed(award, message, detailPath, report) {
  report.errors.push({ award_id: award.id, award_name: award.name, message });
  writeJson(detailPath, {
    version: 1,
    status: "failed",
    generated_at: new Date().toISOString(),
    provider: "gemini-cli",
    model: geminiCliModel,
    award: {
      id: award.id,
      name: award.name,
      official_homepage: award.official_homepage,
    },
    error: message,
  });
  await updateAwardFailure(award.id, message).catch(() => null);
}

async function updateAwardFailure(awardId, message) {
  const { error } = await supabase
    .from("shared_awards")
    .update({
      last_structure_scan_at: new Date().toISOString(),
      structure_scan_error: truncate(message, 900),
      updated_at: new Date().toISOString(),
    })
    .eq("id", awardId);

  if (error) throw new Error(describeSupabaseError(error, "record award detail failure"));
}

async function startWorkerRun(report) {
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      worker_name: "local-award-baseline-detail-worker",
      status: "running",
      ai_provider: "gemini-cli",
      metadata: workerMetadata(report),
    })
    .select("id")
    .maybeSingle();

  if (error) {
    console.log(`WORKER RUN LOG DISABLED | ${describeSupabaseError(error, "record award detail worker run")}`);
    return null;
  }

  return data?.id || null;
}

let lastWorkerUpdateAt = 0;
let lastWorkerUpdateChecked = 0;

async function maybeUpdateWorkerRun(runId, report) {
  if (!runId) return;
  const now = Date.now();
  if (report.checked - lastWorkerUpdateChecked < 10 && now - lastWorkerUpdateAt < 60_000) return;
  lastWorkerUpdateChecked = report.checked;
  lastWorkerUpdateAt = now;
  await updateWorkerRun(runId, report);
}

async function updateWorkerRun(runId, report) {
  if (!runId) return;
  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      checked_count: report.checked,
      changed_count: report.applied,
      unchanged_count: report.skipped_existing,
      initial_count: report.extracted,
      failed_count: report.failed + report.no_baseline,
      metadata: workerMetadata(report),
    })
    .eq("id", runId);

  if (error) console.log(`WORKER RUN UPDATE FAILED | ${error.message}`);
}

async function finishWorkerRun(runId, status, errorMessageValue, report) {
  if (!runId) return;
  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      status,
      checked_count: report.checked,
      changed_count: report.applied,
      unchanged_count: report.skipped_existing,
      initial_count: report.extracted,
      failed_count: report.failed + report.no_baseline,
      error: errorMessageValue ? errorMessageValue.slice(0, 1000) : null,
      metadata: workerMetadata(report),
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) console.log(`WORKER RUN FINISH FAILED | ${error.message}`);
}

function workerMetadata(report) {
  return {
    kind: "award_baseline_details",
    archive_root: report.archive_root,
    details_root: report.details_root,
    ai_model: report.ai_model,
    options: report.options,
    counts: {
      loaded_awards: report.loaded_awards,
      checked: report.checked,
      extracted: report.extracted,
      applied: report.applied,
      skipped_existing: report.skipped_existing,
      no_baseline: report.no_baseline,
      failed: report.failed,
    },
    detail_pipeline: {
      load: {
        awards: report.loaded_awards,
      },
      extraction: {
        model: report.ai_model,
        checked: report.checked,
        extracted: report.extracted,
        failed: report.failed,
        no_baseline: report.no_baseline,
      },
      publishing: {
        enabled: applyUpdates,
        applied: report.applied,
      },
    },
    gemini_cli_usage: report.gemini_cli_usage,
    paths: {
      saved_details: report.saved_detail_paths.slice(-20),
      latest_run: toArchiveRelative(join(detailsRoot, "award-details-latest-run.json")),
    },
    errors: report.errors.slice(-20),
  };
}

function startHeartbeat(report) {
  const intervalMs = heartbeatMinutes * 60 * 1000;
  const startedAtMs = Date.now();
  const timer = setInterval(() => {
    const elapsedMinutes = Math.round((Date.now() - startedAtMs) / 60_000);
    console.log(
      `DETAIL_HEARTBEAT elapsed_minutes=${elapsedMinutes} loaded=${report.loaded_awards} checked=${report.checked} extracted=${report.extracted} applied=${report.applied} skipped_existing=${report.skipped_existing} no_baseline=${report.no_baseline} failed=${report.failed} calls=${report.gemini_cli_usage.calls}`,
    );
  }, intervalMs);
  timer.unref?.();
  return timer;
}

function recordGeminiCliUsage(report, analysis, success) {
  const usage = analysis?.usage || {};
  report.gemini_cli_usage.calls += usage.calls || 1;
  report.gemini_cli_usage.successes += success ? 1 : 0;
  report.gemini_cli_usage.failures += success ? 0 : 1;
  report.gemini_cli_usage.image_files += usage.image_files || 0;
  report.gemini_cli_usage.view_file_calls += usage.view_file_calls || 0;
  report.gemini_cli_usage.stream_calls += usage.stream_calls || 0;
  report.gemini_cli_usage.elapsed_ms += usage.elapsed_ms || 0;
}

function geminiCliCallAvailable(report) {
  if (!geminiCliMaxCalls) return true;
  return report.gemini_cli_usage.calls < geminiCliMaxCalls;
}

function readBaselineEvidence(baseline) {
  const capture = baseline.capture || {};
  const kind = baseline.kind || (capture.pdf ? "pdf" : "webpage");
  const paths = {
    pagePath: capture.page ? fromArchiveRelative(capture.page) : null,
    thumbPath: capture.thumb ? fromArchiveRelative(capture.thumb) : null,
    pdfPath: capture.pdf ? fromArchiveRelative(capture.pdf) : null,
    textPath: capture.text ? fromArchiveRelative(capture.text) : null,
    metaPath: capture.meta ? fromArchiveRelative(capture.meta) : null,
  };
  const requiredPaths = kind === "pdf" ? [paths.pdfPath, paths.textPath] : [paths.thumbPath, paths.textPath];
  const missing = requiredPaths.filter((value) => !value || !existsSync(value));
  if (missing.length) return { ok: false, missing };

  return {
    ok: true,
    kind,
    ...paths,
    text: paths.textPath ? readFileSync(paths.textPath, "utf8") : "",
    meta: paths.metaPath ? readJsonIfExists(paths.metaPath) : null,
  };
}

function baselinePathForSource(sourceId) {
  return join(archiveRoot, "sources", sourceId, "baseline.json");
}

function awardDetailPath(awardId) {
  return join(detailsRoot, "awards", awardId, "details.json");
}

function existingDetailSucceeded(path) {
  const existing = readJsonIfExists(path);
  return existing?.status === "succeeded" && existing?.details;
}

function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function fromArchiveRelative(value) {
  const raw = String(value || "");
  return /^[A-Za-z]:[\\/]/.test(raw) ? raw : join(archiveRoot, raw);
}

function toArchiveRelative(value) {
  const fullPath = resolve(String(value || ""));
  const rel = fullPath.startsWith(archiveRoot) ? fullPath.slice(archiveRoot.length).replace(/^[/\\]+/, "") : fullPath;
  return rel.replaceAll("\\", "/");
}

function sourcePriority(source) {
  const priorities = {
    deadline: 0,
    application: 1,
    eligibility: 2,
    requirements: 3,
    pdf: 4,
    faq: 5,
    homepage: 6,
    other: 7,
  };
  return priorities[source.page_type] ?? 8;
}

function confidenceScore(value) {
  if (value === "high") return 0.85;
  if (value === "medium") return 0.65;
  return 0.35;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [rawKey, inlineValue] = value.slice(2).split("=");
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
    } else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[rawKey] = values[index + 1];
      index += 1;
    } else {
      parsed[rawKey] = "true";
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

function listArg(value, fallback = []) {
  if (value === undefined || value === null || value === "") return fallback;
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean);
  return String(value)
    .split(",")
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function limitArg(value, fallback) {
  if (String(value || "").toLowerCase() === "all") return "all";
  return positiveInt(value, fallback);
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function boundedInt(value, fallback, min, max) {
  const number = positiveInt(value, fallback);
  return Math.min(max, Math.max(min, number));
}

function normalizeVisibleText(value) {
  return repairMojibake(String(value || "")).replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function repairMojibake(value) {
  return String(value || "")
    .replace(/â€™|â€˜/g, "'")
    .replace(/â€œ|â€/g, '"')
    .replace(/â€“|â€”/g, "-")
    .replace(/Â©/g, "(c)")
    .replace(/Â·/g, "-")
    .replace(/Â/g, "");
}

function cleanText(value) {
  return normalizeVisibleText(value).slice(0, 2_000);
}

function cleanNullable(value) {
  const clean = cleanText(value);
  return clean || null;
}

function cleanSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizeConfidence(value) {
  const clean = cleanSlug(value);
  if (clean === "low" || clean === "medium" || clean === "high") return clean;
  return null;
}

function stringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(arrayItemText(item))).filter(Boolean);
  }
  const clean = cleanText(arrayItemText(value));
  return clean ? [clean] : [];
}

function arrayItemText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const object = value;
  const direct = object.text || object.value || object.summary || object.description || object.title || object.name;
  if (direct) return direct;

  const date = object.date || object.deadline || object.opening_date || object.label;
  const note = object.note || object.detail || object.details || object.event;
  if (date && note) return `${date}: ${note}`;
  if (date) return date;
  if (note) return note;

  return Object.entries(object)
    .filter((entry) => ["string", "number", "boolean"].includes(typeof entry[1]))
    .map(([key, item]) => `${key}: ${item}`)
    .join("; ");
}

function jsonObjectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function ensureSentencePunctuation(value) {
  const clean = cleanText(value).replace(/[,:;-\s]+$/g, "").trim();
  if (!clean) return null;
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function truncate(value, maxLength) {
  const clean = cleanText(value);
  if (clean.length <= maxLength) return clean;
  const truncated = clean.slice(0, maxLength + 1);
  const boundary = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, boundary > maxLength * 0.65 ? boundary : maxLength).trim()}...`;
}

function timestampForPath(value = new Date().toISOString()) {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}

function safePathSegment(value) {
  return String(value || "value")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "value";
}

function escapeLike(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error || "Unknown error");
}

function describeSupabaseError(error, action) {
  const message = error?.message || String(error);
  const details = error?.details ? ` ${error.details}` : "";
  const hint = error?.hint ? ` ${error.hint}` : "";
  const code = error?.code ? ` (${error.code})` : "";
  return `${message}${details}${hint}${code} while trying to ${action}.`;
}

try {
  await runOnce();
} catch (error) {
  console.error(errorMessage(error));
  process.exit(1);
}
