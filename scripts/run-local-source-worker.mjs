#!/usr/bin/env node
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import * as cheerio from "cheerio";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const sentenceDotPlaceholder = "__AP_SENTENCE_DOT__";
const summaryPromptChars = 12_000;
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, args.env) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const deepCrawl =
  args["deep-crawl"] === "true" ||
  args["initial-deep-crawl"] === "true" ||
  env.LOCAL_WORKER_DEEP_CRAWL === "true";
const limit = positiveInt(
  args.limit ||
    (deepCrawl ? env.LOCAL_WORKER_DEEP_CRAWL_LIMIT : env.LOCAL_WORKER_PAGE_LIMIT),
  deepCrawl ? 5000 : 25,
);
const maxSubpagesPerSource = positiveInt(
  args["max-subpages"] ||
    (deepCrawl
      ? env.LOCAL_WORKER_DEEP_CRAWL_MAX_SUBPAGES_PER_SOURCE
      : env.LOCAL_WORKER_MAX_SUBPAGES_PER_SOURCE),
  deepCrawl ? 24 : 10,
);
const crawlDepthDefault = deepCrawl ? 2 : 1;
const crawlDepth = positiveInt(
  args["crawl-depth"] ||
    (deepCrawl ? env.LOCAL_WORKER_DEEP_CRAWL_DEPTH : env.LOCAL_WORKER_CRAWL_DEPTH),
  crawlDepthDefault,
);
const awardFilter = args.award || args["award-name"] || env.LOCAL_WORKER_AWARD_FILTER || "";
const sourceIdFilter = args["source-id"] || env.LOCAL_WORKER_SOURCE_ID || "";
const sourceUrlFilter = args["source-url"] || env.LOCAL_WORKER_SOURCE_URL || "";
const refreshExistingSamplesOnly =
  args["refresh-existing-samples-only"] === "true" ||
  env.LOCAL_WORKER_REFRESH_EXISTING_SAMPLES_ONLY === "true";
const baselineRefresh =
  args["baseline-refresh"] === "true" ||
  args["reset-baseline"] === "true" ||
  env.LOCAL_WORKER_BASELINE_REFRESH === "true";
const baselineStartedAt = args["baseline-started-at"] || env.LOCAL_WORKER_BASELINE_STARTED_AT || "";
const discoverSubpages =
  !refreshExistingSamplesOnly && !baselineRefresh && args["discover-subpages"] !== "false";
const includeNotDue =
  deepCrawl || args.all === "true" || args["include-not-due"] === "true";
const forceStructureRescan =
  deepCrawl || args["force-structure"] === "true" || args["force-structure-rescan"] === "true";
const debugSourcePolicy = args["debug-source-policy"] === "true";
const coverageFirst =
  deepCrawl ||
  args["coverage-first"] === "true" ||
  env.LOCAL_WORKER_COVERAGE_FIRST === "true";
const checkIntervalMinutes = positiveInt(
  args["check-interval-minutes"] ||
    env.LOCAL_WORKER_CHECK_INTERVAL_MINUTES ||
    hoursToMinutes(args["check-interval-hours"] || env.LOCAL_WORKER_CHECK_INTERVAL_HOURS),
  90,
);
const delayMs = nonNegativeInt(
  args["delay-ms"] || env.LOCAL_WORKER_DELAY_MS,
  deepCrawl ? 750 : 0,
);
const domainDelayMs = nonNegativeInt(
  args["domain-delay-ms"] || env.LOCAL_WORKER_DOMAIN_DELAY_MS,
  deepCrawl ? 1_500 : 750,
);
const sourceTimeoutMs = positiveInt(
  args["source-timeout-ms"] || env.LOCAL_WORKER_SOURCE_TIMEOUT_MS,
  deepCrawl ? 120_000 : 60_000,
);
const maxSourceBytes = positiveInt(
  args["max-source-bytes"] || env.LOCAL_WORKER_MAX_SOURCE_BYTES,
  25 * 1024 * 1024,
);
const structureRescanDays = positiveInt(
  args["structure-rescan-days"] || env.LOCAL_WORKER_STRUCTURE_RESCAN_DAYS,
  7,
);
const aiSummaryProvider = selectAiProvider(
  args["ai-provider"] || env.LOCAL_WORKER_AI_PROVIDER || env.AI_PROVIDER,
  {
    gemini: env.GEMINI_API_KEY,
    openai: env.OPENAI_API_KEY,
  },
);
const aiSummaries =
  Boolean(aiSummaryProvider) &&
  args.ai !== "false" &&
  env.LOCAL_WORKER_AI_SUMMARIES !== "false";

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);

const seenSourceIds = new Set();
const seenUrls = new Set();
const stats = {
  checked: 0,
  changed: 0,
  unchanged: 0,
  initial: 0,
  discovered: 0,
  sourceRequests: 0,
  failed: 0,
  aiProvider: aiSummaries ? aiSummaryProvider : "none",
  mode: refreshExistingSamplesOnly
    ? "refresh-existing-samples"
    : baselineRefresh
      ? "baseline-refresh"
      : deepCrawl
        ? "deep-crawl"
        : "scheduled",
};

let workerRunId = null;
let currentSource = null;
let fatalExitStarted = false;
const completedSourceIds = new Set();
const recoverableCrashBySourceId = new Map();
const hostLastFetchAt = new Map();
const crawlerUserAgent =
  "Mozilla/5.0 (compatible; AwardPingLocalWorker/1.0; +https://awardping.com/contact; public award page monitor)";
const fallbackUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AwardPingLocalWorker/1.0 Chrome/124.0 Safari/537.36 (+https://awardping.com/contact)";
const institutionalDiscoveryHosts = new Set([
  "fellowship-finder.grad.illinois.edu",
  "onsa.asu.edu",
]);
const cmsAdminHosts = new Set(["a.cms.omniupdate.com"]);
const phoneNumberPathSegment = /(?:^|\/)\+?(?:\d[\d().-]*){9,}(?:\/|$)/;
const protectedOfficialSourcePageTypes = new Set([
  "homepage",
  "deadline",
  "application",
  "eligibility",
  "requirements",
  "pdf",
  "faq",
]);

const nonOfficialExternalHosts = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "paypal.com",
  "twitter.com",
  "x.com",
  "youtube.com",
]);

const separateProgramHostGroups = [
  new Set(["us.fulbrightonline.org", "foreign.fulbrightonline.org"]),
];

process.on("uncaughtException", (error) => {
  void handleFatalWorkerError("uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  void handleFatalWorkerError("unhandledRejection", reason);
});

try {
  workerRunId = await startWorkerRun();
  stats.sourceRequests = await processSourcePageRequests();
  const pending = await loadSources(limit);

  while (pending.length > 0 && stats.checked < limit) {
    const source = pending.shift();
    if (!source || seenSourceIds.has(source.id)) continue;

    seenSourceIds.add(source.id);
    seenUrls.add(normalizeUrlKey(source.url));
    currentSource = source;

    const result = await checkSharedSourceWithTimeout(source);
    if (
      result.ok &&
      discoverSubpages &&
      (source._crawlDepth || 0) < crawlDepth &&
      result.links.length > 0 &&
      (forceStructureRescan || structureScanDue(source.shared_awards))
    ) {
      try {
        const discovered = await addDiscoveredSubpages(source, result.links);
        stats.discovered += discovered.length;

        for (const discoveredSource of discovered) {
          if (stats.checked + pending.length >= limit) break;
          const urlKey = normalizeUrlKey(discoveredSource.url);
          if (!seenSourceIds.has(discoveredSource.id) && !seenUrls.has(urlKey)) {
            pending.push({
              ...discoveredSource,
              _crawlDepth: (source._crawlDepth || 0) + 1,
            });
            seenUrls.add(urlKey);
          }
        }

        await markStructureScan(source.shared_award_id, null);
      } catch (error) {
        await markStructureScan(
          source.shared_award_id,
          error instanceof Error ? error.message : "Structure scan failed.",
        );
        console.log(
          `STRUCTURE FAILED ${source.shared_awards?.name || source.title} | ${
            error instanceof Error ? error.message : "Structure scan failed."
          }`,
        );
      }
    }

    if (delayMs > 0 && pending.length > 0 && stats.checked < limit) {
      await sleep(delayMs);
    }

    currentSource = null;
  }

  await finishWorkerRun(workerRunId, "succeeded", null);
  console.log(JSON.stringify(workerOutput(true), null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Local worker failed.";
  await finishWorkerRun(workerRunId, "failed", message);
  console.error(message);
  process.exit(1);
}

async function handleFatalWorkerError(kind, error) {
  const message = error instanceof Error ? error.message : String(error || "Unknown fatal worker error.");
  const stack = error instanceof Error && error.stack ? error.stack : message;
  const source = currentSource;
  const sourceLabel = source ? `${source.shared_awards?.name || source.title} | ${source.url}` : "no active source";
  const fatalMessage = `Fatal ${kind}: ${message}`;

  if (source?.id && isRecoverableSourceCrash(message, stack)) {
    recoverableCrashBySourceId.set(source.id, fatalMessage);
    console.log(`RECOVER ${sourceLabel} | ${fatalMessage}`);
    console.log(stack);
    return;
  }

  if (fatalExitStarted) return;
  fatalExitStarted = true;

  console.error(`FATAL  ${sourceLabel} | ${fatalMessage}`);
  console.error(stack);

  if (source?.id) {
    try {
      await markSourceFailed(source, fatalMessage, { fatal: true });
    } catch (markError) {
      console.error(
        `FATAL LOG FAILED | ${markError instanceof Error ? markError.message : String(markError)}`,
      );
    }
  }

  try {
    await finishWorkerRun(workerRunId, "failed", `${fatalMessage} | ${sourceLabel}`);
  } catch (finishError) {
    console.error(
      `WORKER RUN FATAL LOG FAILED | ${
        finishError instanceof Error ? finishError.message : String(finishError)
      }`,
    );
  }

  process.exit(1);
}

function workerOutput(ok) {
  return {
    ok,
    checked: stats.checked,
    changed: stats.changed,
    unchanged: stats.unchanged,
    initial: stats.initial,
    discoveredSubpages: stats.discovered,
    queuedSourceRequests: stats.sourceRequests,
    failed: stats.failed,
    aiProvider: stats.aiProvider,
    mode: stats.mode,
    limit,
    crawlDepth,
    maxSubpagesPerSource,
    coverageFirst,
    awardFilter: awardFilter || null,
    sourceIdFilter: sourceIdFilter || null,
    sourceUrlFilter: sourceUrlFilter || null,
    refreshExistingSamplesOnly,
    baselineRefresh,
    baselineStartedAt: baselineStartedAt || null,
    delayMs,
    sourceTimeoutMs,
  };
}

async function startWorkerRun() {
  const { data, error } = await supabase
    .from("local_worker_runs")
    .insert({
      worker_name: refreshExistingSamplesOnly
        ? "local-source-worker-refresh-samples"
        : baselineRefresh
          ? "local-source-worker-baseline-refresh"
          : deepCrawl
            ? "local-source-worker-deep-crawl"
            : "local-source-worker",
      status: "running",
      ai_provider: stats.aiProvider,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    console.log(`WORKER RUN LOG DISABLED | ${describeSupabaseError(error, "record worker run")}`);
    return null;
  }

  return data?.id || null;
}

async function finishWorkerRun(runId, status, errorMessage) {
  if (!runId) return;

  const { error } = await supabase
    .from("local_worker_runs")
    .update({
      status,
      checked_count: stats.checked,
      changed_count: stats.changed,
      unchanged_count: stats.unchanged,
      initial_count: stats.initial,
      discovered_count: stats.discovered,
      failed_count: stats.failed,
      error: errorMessage ? errorMessage.slice(0, 1000) : null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) {
    console.log(`WORKER RUN LOG FAILED | ${error.message}`);
  }
}

async function loadSources(pageLimit) {
  const rows = [];
  const pageSize = 1000;

  for (let from = 0; rows.length < pageLimit; from += pageSize) {
    const to = Math.min(from + pageSize - 1, pageLimit - 1);
    const { data, error } = await buildSourcesQuery()
      .order("next_check_at", { ascending: true })
      .order("created_at", { ascending: true })
      .range(from, to);

    if (error) {
      throw new Error(describeSupabaseError(error, "load shared award sources"));
    }

    rows.push(...(data || []));
    if (!data || data.length < to - from + 1) break;
  }

  if (coverageFirst) {
    const sourceCountsByAwardId = new Map();
    for (const row of rows) {
      sourceCountsByAwardId.set(
        row.shared_award_id,
        (sourceCountsByAwardId.get(row.shared_award_id) || 0) + 1,
      );
    }

    rows.sort((a, b) => {
      const countDelta =
        (sourceCountsByAwardId.get(a.shared_award_id) || 0) -
        (sourceCountsByAwardId.get(b.shared_award_id) || 0);
      if (countDelta !== 0) return countDelta;

      return new Date(a.next_check_at).getTime() - new Date(b.next_check_at).getTime();
    });
  }

  return rows.slice(0, pageLimit).map((source) => ({ ...source, _crawlDepth: 0 }));
}

async function processSourcePageRequests() {
  if (refreshExistingSamplesOnly || baselineRefresh) return 0;

  const { data, error } = await supabase
    .from("source_page_requests")
    .select("id, user_id, award_name, homepage_url, notes, status")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    const message = String(error.message || "").toLowerCase();
    if (
      error.code === "PGRST205" ||
      message.includes("could not find the table") ||
      message.includes("does not exist")
    ) {
      return 0;
    }
    throw error;
  }

  let queued = 0;
  for (const request of data || []) {
    try {
      if (!isTrackableOfficialSourceUrl(request.homepage_url)) {
        await updateSourcePageRequestStatus(request.id, "rejected");
        console.log(`REQUEST REJECTED ${request.award_name} | non-monitorable URL | ${request.homepage_url}`);
        continue;
      }

      const sharedAwardId = await upsertRequestedSharedAward(request);
      await upsertRequestedHomepageSource(request, sharedAwardId);
      await updateSourcePageRequestStatus(request.id, "queued");
      queued += 1;
      console.log(`REQUEST QUEUED ${request.award_name} | ${request.homepage_url}`);
    } catch (error) {
      await updateSourcePageRequestStatus(request.id, "rejected").catch(() => {});
      console.log(
        `REQUEST FAILED ${request.award_name} | ${
          error instanceof Error ? error.message : "Source request could not be queued."
        }`,
      );
    }
  }

  return queued;
}

async function upsertRequestedSharedAward(request) {
  const searchKey = normalizeSharedAwardKey(request.award_name);
  if (!searchKey) throw new Error("Award name is missing.");

  const { data: existingAward, error: selectError } = await supabase
    .from("shared_awards")
    .select("id, official_homepage")
    .eq("search_key", searchKey)
    .maybeSingle();
  if (selectError) throw selectError;

  if (existingAward?.id) {
    const updates = {
      status: "active",
      next_structure_scan_at: new Date(0).toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (!existingAward.official_homepage) {
      updates.official_homepage = request.homepage_url;
    }

    const { error: updateError } = await supabase
      .from("shared_awards")
      .update(updates)
      .eq("id", existingAward.id);
    if (updateError) throw updateError;

    return existingAward.id;
  }

  const { data: insertedAward, error: insertError } = await supabase
    .from("shared_awards")
    .insert({
      search_key: searchKey,
      name: request.award_name.trim(),
      official_homepage: request.homepage_url,
      summary: null,
      confidence: 0.65,
      status: "active",
      source: "user",
      submitted_by_user_id: request.user_id || null,
      next_structure_scan_at: new Date(0).toISOString(),
    })
    .select("id")
    .single();
  if (insertError) throw insertError;

  return insertedAward.id;
}

async function upsertRequestedHomepageSource(request, sharedAwardId) {
  const { error } = await supabase.from("shared_award_sources").upsert(
    {
      shared_award_id: sharedAwardId,
      url: request.homepage_url,
      title: request.award_name.trim(),
      page_type: "homepage",
      confidence: 0.85,
      reason: sourceRequestReason(request),
      source: "user",
      submitted_by_user_id: request.user_id || null,
      next_check_at: new Date(0).toISOString(),
      consecutive_failures: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "shared_award_id,url" },
  );
  if (error) throw error;
}

function sourceRequestReason(request) {
  const notes = request.notes?.trim();
  return [
    "User requested source discovery from this official main award page.",
    notes ? `Notes: ${notes}` : "",
  ].filter(Boolean).join(" ");
}

async function updateSourcePageRequestStatus(id, status) {
  const { error } = await supabase
    .from("source_page_requests")
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

function buildSourcesQuery() {
  let query = supabase
    .from("shared_award_sources")
    .select(
      "id, shared_award_id, url, title, page_type, confidence, source, last_hash, last_checked_at, next_check_at, consecutive_failures, shared_awards!inner(id, name, status, next_structure_scan_at)",
    )
    .eq("shared_awards.status", "active");

  if (!includeNotDue) {
    query = query.lte("next_check_at", new Date().toISOString());
  }

  if (baselineRefresh && baselineStartedAt.trim()) {
    query = query.or(`last_checked_at.is.null,last_checked_at.lt.${baselineStartedAt.trim()}`);
  }

  if (awardFilter.trim()) {
    query = query.ilike("shared_awards.name", `%${escapeLike(awardFilter.trim())}%`);
  }
  if (sourceIdFilter.trim()) {
    query = query.eq("id", sourceIdFilter.trim());
  }
  if (sourceUrlFilter.trim()) {
    query = query.eq("url", sourceUrlFilter.trim());
  }

  if (deepCrawl && args["include-failed"] !== "true") {
    query = query.or("consecutive_failures.is.null,consecutive_failures.lt.3");
  }

  return query;
}

function describeSupabaseError(error, action) {
  const message = error?.message || String(error);
  const details = error?.details ? ` ${error.details}` : "";
  const hint = error?.hint ? ` ${error.hint}` : "";
  const code = error?.code ? ` (${error.code})` : "";
  const fullText = `${message}${details}${hint}`.toLowerCase();

  if (fullText.includes("invalid api key")) {
    return [
      "Invalid Supabase service_role key.",
      "Re-run the Windows installer and paste the Supabase project service_role key for the AwardPing Supabase project.",
      "This is different from the Gemini API key, Vercel key, anon key, or Cloudflare token.",
    ].join(" ");
  }

  if (
    fullText.includes("fetch failed") ||
    fullText.includes("failed to fetch") ||
    fullText.includes("econnrefused") ||
    fullText.includes("enotfound")
  ) {
    return `Could not reach Supabase while trying to ${action}. Check NEXT_PUBLIC_SUPABASE_URL in the worker env file. Current URL: ${supabaseUrl}.`;
  }

  if (
    fullText.includes("does not exist") ||
    fullText.includes("could not find the table") ||
    fullText.includes("could not find the") ||
    fullText.includes("schema cache") ||
    error?.code === "PGRST204" ||
    error?.code === "PGRST205"
  ) {
    return `${message}${code}. The Supabase schema is missing the local-worker/shared-award history tables or columns. Apply supabase/migrations/0008_shared_award_history.sql and supabase/migrations/0011_local_worker_runs.sql before running the local worker.`;
  }

  return `${message}${code}`;
}

async function checkSharedSourceWithTimeout(source) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const recoveredCrash = recoverableCrashBySourceId.get(source.id);
      reject(
        new Error(
          recoveredCrash ||
            `Source timed out after ${Math.round(sourceTimeoutMs / 1000)} seconds.`,
        ),
      );
    }, sourceTimeoutMs);
  });

  try {
    return await Promise.race([checkSharedSource(source), timeoutPromise]);
  } catch (error) {
    const message = describeError(error, "Unknown worker failure.");
    await markSourceFailed(source, message);
    console.log(`FAILED  ${source.shared_awards?.name || source.title} | ${message}`);
    return { ok: false, links: [] };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    recoverableCrashBySourceId.delete(source.id);
  }
}

async function checkSharedSource(source) {
  try {
    if (debugSourcePolicy) {
      console.log(
        "SOURCE POLICY",
        JSON.stringify({
          id: source.id,
          award: source.shared_awards?.name || null,
          title: source.title,
          url: source.url,
          trackable: isTrackableOfficialSourceUrl(source.url),
          monitorable: isMonitorableSharedSource(source),
          protectedPageType: isProtectedOfficialSourcePageType(source.page_type),
          hardBlocked: isHardBlockedOfficialSourceUrl(source.url),
          nonAward: isClearlyNonAwardSourceUrl(source.url),
          nonAwardChecks: debugNonAwardSourceUrlChecks(source.url),
          institutionalDiscovery: isInstitutionalDiscoveryUrl(source.url),
        }),
      );
    }

    if (!isMonitorableSharedSource(source)) {
      await supabase
        .from("shared_award_sources")
        .update({
          last_checked_at: new Date().toISOString(),
          next_check_at: nextCheckDate(),
          consecutive_failures: 0,
          last_error: "Skipped non-award source URL.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", source.id);

      if (markSourceOutcome(source, "unchanged")) {
        console.log(`SKIP    ${source.shared_awards?.name || source.title} | non-award source URL`);
      }
      return { ok: true, links: [] };
    }

    const content = await fetchExtractedContent(source.url, contentTypeForPage(source.page_type, source.url));
    if (looksLikeSourceAccessErrorPage(content.text)) {
      throw new Error("Source returned an access, missing, or error page instead of award content.");
    }
    if (looksLikeBrokenDynamicPage(content.text)) {
      throw new Error("Source returned a dynamic loading or CSS error page instead of award content.");
    }
    if (looksLikeNonContentStubPage(source, content.text)) {
      throw new Error("Source returned a sitemap or non-content stub instead of award content.");
    }
    if (looksLikeLoginWallPage(content.text)) {
      throw new Error("Source returned a login page instead of award content.");
    }

    const sourceForContent = await maybeImproveSourceTitle(source, content);
    throwIfRecoverableCrash(source);
    const discoveryOnly = isInstitutionalDiscoveryUrl(source.url);

    if (discoveryOnly) {
      await supabase
        .from("shared_award_sources")
        .update({
          title: sourceForContent.title,
          last_checked_at: new Date().toISOString(),
          next_check_at: nextCheckDate(),
          consecutive_failures: 0,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", source.id);

      if (markSourceOutcome(source, "unchanged")) {
        console.log(`DISCOVER ${source.shared_awards?.name || source.title} | institutional page used only to find official links`);
      }
      return { ok: true, links: content.links };
    }

    const previousHash = sourceForContent.last_hash;
    const previousSnapshot = previousHash
      ? await getSharedSnapshotByHash(sourceForContent.shared_award_id, sourceForContent.url, previousHash)
      : null;

    if (refreshExistingSamplesOnly) {
      if (previousHash && previousHash === content.hash) {
        await upsertSharedSnapshot(sourceForContent, content);
        await supabase
          .from("shared_award_sources")
          .update({
            title: sourceForContent.title,
            last_checked_at: new Date().toISOString(),
            next_check_at: nextCheckDate(),
            consecutive_failures: 0,
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", source.id);

        const previousLength = previousSnapshot?.text_sample?.length || 0;
        const action = content.sample.length > previousLength ? "REFRESH" : "OK";
        if (markSourceOutcome(source, "unchanged")) {
          console.log(
            `${action} ${source.shared_awards?.name || source.title} | snapshot chars ${previousLength} -> ${content.sample.length}`,
          );
        }
      } else {
        if (markSourceOutcome(source, "unchanged")) {
          console.log(
            `SKIP    ${source.shared_awards?.name || source.title} | current hash differs; leaving for normal change processing`,
          );
        }
      }

      return { ok: true, links: [] };
    }

    if (baselineRefresh) {
      const newSnapshot = await upsertSharedSnapshot(sourceForContent, content);
      await supabase
        .from("shared_award_sources")
        .update({
          title: sourceForContent.title,
          last_hash: content.hash,
          last_checked_at: new Date().toISOString(),
          next_check_at: nextCheckDate(),
          consecutive_failures: 0,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", source.id);

      const previousLength = previousSnapshot?.text_sample?.length || 0;
      const changed = Boolean(previousHash && previousHash !== content.hash);
      const action = changed ? "BASELINE" : content.sample.length > previousLength ? "REFRESH" : "OK";
      if (markSourceOutcome(source, "unchanged")) {
        console.log(
          `${action} ${source.shared_awards?.name || source.title} | snapshot ${newSnapshot?.id || "unknown"} | chars ${previousLength} -> ${content.sample.length}`,
        );
      }

      return { ok: true, links: [] };
    }

    const newSnapshot = await upsertSharedSnapshot(sourceForContent, content);
    const changed = Boolean(previousHash && previousHash !== content.hash);

    let outcome = null;
    let logLine = null;

    if (changed) {
      const changeDetails = await buildChangeDetailsForSource(
        sourceForContent,
        previousSnapshot?.text_sample || null,
        content.text,
      );
      const summary = changeDetails.reader_summary;
      if (!changeDetails.is_alert_worthy) {
        outcome = "unchanged";
        logLine = `NOISE   ${source.shared_awards?.name || source.title} | ${summary}`;
      } else if (await findDuplicateSharedChangeSummary(source, changeDetails)) {
        outcome = "unchanged";
        logLine = `DUPLICATE ${source.shared_awards?.name || source.title} | repeat summary skipped`;
      } else {
        const { error } = await supabase
          .from("shared_award_change_events")
          .upsert(
            {
              shared_award_id: source.shared_award_id,
              shared_award_source_id: source.id,
              source_url: source.url,
              source_title: sourceForContent.title,
              source_page_type: source.page_type,
              previous_snapshot_id: previousSnapshot?.id || null,
              new_snapshot_id: newSnapshot?.id || null,
              previous_hash: previousHash,
              new_hash: content.hash,
              summary,
              change_details: changeDetails,
              detected_at: new Date().toISOString(),
            },
            {
              onConflict: "shared_award_id,source_url,previous_hash,new_hash",
              ignoreDuplicates: true,
            },
          );

        if (error) throw error;
        outcome = "changed";
        logLine = `CHANGED ${source.shared_awards?.name || source.title} | ${summary}`;
      }
    } else if (previousHash) {
      outcome = "unchanged";
      logLine = `OK      ${source.shared_awards?.name || source.title}`;
    } else {
      outcome = "initial";
      logLine = `INIT    ${source.shared_awards?.name || source.title}`;
    }

    throwIfRecoverableCrash(source);
    await supabase
      .from("shared_award_sources")
      .update({
        title: sourceForContent.title,
        last_hash: content.hash,
        last_checked_at: new Date().toISOString(),
        next_check_at: nextCheckDate(),
        consecutive_failures: 0,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", source.id);

    if (outcome && logLine && markSourceOutcome(source, outcome)) {
      console.log(logLine);
    }

    return { ok: true, links: content.links };
  } catch (error) {
    const message = describeError(error, "Unknown worker failure.");
    await markSourceFailed(source, message);
    console.log(`FAILED  ${source.shared_awards?.name || source.title} | ${message}`);
    return { ok: false, links: [] };
  }
}

function describeError(error, fallback) {
  if (!(error instanceof Error)) return fallback;

  const parts = [error.message || fallback];
  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const causeCode = typeof cause.code === "string" ? cause.code : "";
    const causeMessage = typeof cause.message === "string" ? cause.message : "";

    if (causeMessage && !parts.some((part) => part.includes(causeMessage))) {
      parts.push(causeMessage);
    }

    if (causeCode && !parts.some((part) => part.includes(causeCode))) {
      parts.push(`(${causeCode})`);
    }
  }

  return parts.filter(Boolean).join(": ");
}

async function findDuplicateSharedChangeSummary(source, changeDetails) {
  const key = changeSummaryDedupeKey({
    shared_award_id: source.shared_award_id,
    source_url: source.url,
    summary: changeDetails.reader_summary,
    change_details: changeDetails,
  });
  if (!key) return null;

  const { data, error } = await supabase
    .from("shared_award_change_events")
    .select("id, shared_award_id, source_url, summary, change_details, detected_at")
    .eq("shared_award_id", source.shared_award_id)
    .order("detected_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return (
    (data || []).find((change) => changeSummaryDedupeKey(change) === key) || null
  );
}

async function markSourceFailed(source, message, options = {}) {
  if (completedSourceIds.has(source.id)) return;

  const failureCount = options.fatal
    ? Math.max((source.consecutive_failures || 0) + 1, 3)
    : (source.consecutive_failures || 0) + 1;

  await supabase
    .from("shared_award_sources")
    .update({
      last_checked_at: new Date().toISOString(),
      next_check_at: nextCheckDate(6 * 60),
      consecutive_failures: failureCount,
      last_error: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("id", source.id);

  markSourceOutcome(source, "failed");
}

function markSourceOutcome(source, outcome) {
  if (completedSourceIds.has(source.id)) return false;
  completedSourceIds.add(source.id);
  stats.checked += 1;
  stats[outcome] += 1;
  return true;
}

function throwIfRecoverableCrash(source) {
  const message = recoverableCrashBySourceId.get(source.id);
  if (message) throw new Error(message);
}

function isRecoverableSourceCrash(message, stack) {
  const fullText = `${message} ${stack}`.toLowerCase();
  return /other side closed|session has been destroyed|target closed|browser has been closed|page has been closed|socket hang up|econnreset|etimedout|und_err|fetch failed|networkerror|terminated|aborted|premature close|connection closed|stream closed/.test(fullText);
}

async function addDiscoveredSubpages(parentSource, links) {
  const ranked = rankLinks(parentSource, links).slice(0, maxSubpagesPerSource);
  if (!ranked.length) return [];

  const { data: existing } = await supabase
    .from("shared_award_sources")
    .select("id, url")
    .eq("shared_award_id", parentSource.shared_award_id);
  const existingUrls = new Set((existing || []).map((row) => normalizeUrlKey(row.url)));

  const rows = ranked
    .filter(
      (candidate) =>
        isTrackableOfficialSourceUrl(candidate.url) &&
        !existingUrls.has(normalizeUrlKey(candidate.url)),
    )
    .map((candidate) => ({
      shared_award_id: parentSource.shared_award_id,
      url: candidate.url,
      title: candidate.title,
      page_type: candidate.pageType,
      confidence: candidate.confidence,
      reason: `Local worker discovered this ${candidate.pageType} page from ${parentSource.url}.`,
      source: "admin",
    }));

  if (!rows.length) return [];

  const { error } = await supabase
    .from("shared_award_sources")
    .upsert(rows, { onConflict: "shared_award_id,url", ignoreDuplicates: true });
  if (error) throw error;

  const urls = rows.map((row) => row.url);
  const { data, error: selectError } = await supabase
    .from("shared_award_sources")
    .select(
      "id, shared_award_id, url, title, page_type, confidence, source, last_hash, last_checked_at, next_check_at, consecutive_failures, shared_awards!inner(id, name, status, next_structure_scan_at)",
    )
    .eq("shared_award_id", parentSource.shared_award_id)
    .in("url", urls);
  if (selectError) throw selectError;

  for (const row of data || []) {
    console.log(`DISCOVERED ${parentSource.shared_awards?.name || parentSource.title} | ${row.url}`);
  }

  return data || [];
}

async function maybeImproveSourceTitle(source, content) {
  if (!shouldImproveSourceTitle(source.title, source.url)) return source;
  if (aiSummaryProvider !== "gemini" || !env.GEMINI_API_KEY || env.LOCAL_WORKER_AI_TITLES === "false") {
    return source;
  }

  const title = await generateSourceTitleWithGemini(source, content);
  if (!title || normalizeTitleKey(title) === normalizeTitleKey(source.title)) return source;

  return {
    ...source,
    title,
  };
}

async function generateSourceTitleWithGemini(source, content) {
  try {
    const model = env.GEMINI_TITLE_MODEL || env.GEMINI_SUMMARY_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(model) +
        ":generateContent?key=" +
        encodeURIComponent(env.GEMINI_API_KEY),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: [
                  "You create concise page titles for an award-source outline UI.",
                  "Return JSON only: {\"title\":\"...\"}.",
                  "The title must be 2-7 words, Title Case, specific to this exact page, and useful in a source-page list.",
                  "Do not use generic labels like Apply, Learn More, Here, Guidelines, Application, or Source Page unless no better context exists.",
                  "Do not include the award name unless needed to distinguish the page.",
                  "Prefer labels like Application Instructions, Eligibility Requirements, Selection Criteria, Recommendation Guidance, FAQ, Deadline Calendar, Financial Aid, Program Overview, or a specific PDF/form title.",
                ].join(" "),
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    `Award: ${source.shared_awards?.name || "Unknown award"}`,
                    `Stored title: ${source.title || ""}`,
                    `HTML title: ${content.pageTitle || ""}`,
                    `Page type: ${source.page_type || "unknown"}`,
                    `URL: ${source.url}`,
                    "",
                    "Readable page text excerpt:",
                    content.text.slice(0, 5000),
                  ].join("\n"),
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.05,
            maxOutputTokens: 80,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                title: { type: "string" },
              },
              required: ["title"],
            },
          },
        }),
        signal: AbortSignal.timeout(14_000),
      },
    );

    if (!response.ok) return null;
    const data = await response.json();
    const parsed = parseJsonObjectFromText(extractGeminiText(data));
    return cleanGeneratedSourceTitle(parsed?.title);
  } catch {
    return null;
  }
}

function shouldImproveSourceTitle(title, url) {
  const clean = normalizeText(String(title || ""));
  if (!clean) return true;
  if (/^\/+$/.test(clean)) return true;
  if (looksLikeUrlTitle(clean)) return true;
  if (isGenericSourceTitle(clean)) return true;
  if (url && normalizeTitleKey(clean) === normalizeTitleKey(readableTitleFromUrlPath(url))) return true;
  return false;
}

function cleanGeneratedSourceTitle(value) {
  const clean = normalizeText(String(value || ""))
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.。]+$/g, "")
    .slice(0, 80)
    .trim();
  if (!clean || isGenericSourceTitle(clean) || looksLikeUrlTitle(clean)) return null;
  if (clean.split(/\s+/).length > 9) return null;
  return clean
    .split(/\s+/)
    .map((word) =>
      /^(FAQ|PDF|NSF|GRFP|USA|US|UK|PHD|NASA|R&D|AAAS)$/i.test(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function isGenericSourceTitle(value) {
  return /^(apply|applications?|learn more|read more|view more|more information|details?|click here|here|tips here\.?|guidelines?|forms?|download|source page|homepage|other source)$/i.test(
    normalizeText(value),
  );
}

function looksLikeUrlTitle(value) {
  const clean = normalizeText(value);
  return (
    /^https?:\/\//i.test(clean) ||
    /^\/[^/]+(?:\/[^/]+)*\/?$/i.test(clean) ||
    /^[a-z0-9-]+(?:\/[a-z0-9-]+)+\/?$/i.test(clean)
  );
}

function readableTitleFromUrlPath(value) {
  try {
    const url = new URL(value);
    const segment = url.pathname.split("/").filter(Boolean).at(-1) || "";
    return segment.replace(/\.(html?|php|aspx?|pdf)$/i, "").replace(/[-_]+/g, " ");
  } catch {
    return "";
  }
}

function normalizeTitleKey(value) {
  return normalizeText(String(value || "")).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function fetchExtractedContent(rawUrl, preferredType = "auto") {
  const safeUrl = await assertPublicHttpUrl(rawUrl);
  await waitForCrawlerHost(safeUrl);
  const response = await fetchCrawlerResponse(safeUrl);

  if (!response.ok) {
    throw new Error(`Fetch failed with HTTP ${response.status}.`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxSourceBytes) throw new Error("Source is too large for the worker limit.");

  const contentType = response.headers.get("content-type") || "";
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxSourceBytes) throw new Error("Source is too large for the worker limit.");

  const isPdf =
    preferredType === "pdf" ||
    (preferredType === "auto" &&
      (contentType.includes("application/pdf") || safeUrl.pathname.toLowerCase().endsWith(".pdf")));

  const html = isPdf ? "" : Buffer.from(arrayBuffer).toString("utf8");
  const rawText = isPdf
    ? await extractPdfText(arrayBuffer)
    : extractHtmlText(html);
  const text = normalizeText(rawText);
  if (!text) throw new Error("No readable text was found on this URL.");

  return {
    url: safeUrl.toString(),
    hash: hashText(text),
    text,
    sample: text,
    byteLength: arrayBuffer.byteLength,
    statusCode: response.status,
    contentType,
    pageTitle: isPdf ? "" : extractHtmlTitle(html),
    links: isPdf ? [] : extractLinks(html, safeUrl),
  };
}

async function fetchCrawlerResponse(url) {
  const attempts = [
    crawlerHeaders(crawlerUserAgent),
    crawlerHeaders(fallbackUserAgent),
  ];
  let latestResponse = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const response = await fetch(url, {
      redirect: "follow",
      headers: attempts[index],
      signal: AbortSignal.timeout(Math.min(sourceTimeoutMs, deepCrawl ? 45_000 : 24_000)),
    });

    if (response.ok) return response;
    latestResponse = response;

    if (index === attempts.length - 1 || !shouldRetryWithAlternateHeaders(response.status)) {
      return response;
    }

    await response.body?.cancel().catch(() => undefined);
    await sleep(retryDelayMs(response));
  }

  return latestResponse;
}

function crawlerHeaders(userAgent) {
  return {
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,text/plain;q=0.7,*/*;q=0.5",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer: "https://awardping.com/",
  };
}

function shouldRetryWithAlternateHeaders(status) {
  return status === 403 || status === 405 || status === 429 || status >= 500;
}

function retryDelayMs(response) {
  if (response.status !== 429) return 750;
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return 2_000;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 1_000), 8_000);

  const retryAt = new Date(retryAfter).getTime();
  if (Number.isFinite(retryAt)) return Math.min(Math.max(retryAt - Date.now(), 1_000), 8_000);

  return 2_000;
}

async function waitForCrawlerHost(url) {
  if (domainDelayMs <= 0) return;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const now = Date.now();
  const lastFetchedAt = hostLastFetchAt.get(host) || 0;
  const waitMs = Math.max(0, domainDelayMs - (now - lastFetchedAt));
  if (waitMs > 0) await sleep(waitMs);
  hostLastFetchAt.set(host, Date.now());
}

function extractHtmlText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, canvas, iframe").remove();
  $("br").replaceWith("\n");
  $("p, div, section, article, header, footer, main, aside, nav, li, h1, h2, h3, h4, h5, h6, td, th")
    .prepend("\n")
    .append("\n");
  return $("body").text() || $.root().text();
}

function extractHtmlTitle(html) {
  const $ = cheerio.load(html);
  return normalizeText(
    $("meta[property='og:title']").attr("content") ||
      $("meta[name='twitter:title']").attr("content") ||
      $("title").first().text() ||
      $("h1").first().text() ||
      "",
  );
}

function extractLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = [];
  const institutionalDiscoveryPage = isInstitutionalDiscoveryUrl(baseUrl.toString());
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    const title = normalizeText($(element).text() || $(element).attr("aria-label") || "");
    if (!href) return;

    try {
      const url = new URL(href, baseUrl);
      url.hash = "";
      if (!["http:", "https:"].includes(url.protocol)) return;
      const relatedHost = isRelatedHost(url.hostname, baseUrl.hostname);
      if (institutionalDiscoveryPage) {
        if (!isLikelyOfficialExternalLink(url, title, baseUrl)) return;
      } else if (!relatedHost) {
        return;
      }
      if (isExcludedUrl(url)) return;
      links.push({ url: url.toString(), title: title || url.pathname });
    } catch {
      // Ignore malformed hrefs.
    }
  });

  const seen = new Set();
  return links.filter((link) => {
    const key = normalizeUrlKey(link.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function extractPdfText(arrayBuffer) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(arrayBuffer) });
  try {
    const result = await parser.getText({ first: 20 });
    return result.text;
  } finally {
    await parser.destroy();
  }
}

function rankLinks(source, links) {
  const awardName = source.shared_awards?.name || source.title;
  const sourceUrl = new URL(source.url);
  const sourceDirectory = directoryPath(sourceUrl.pathname);
  const sourceIsInstitutionalDiscovery = isInstitutionalDiscoveryUrl(source.url);
  const awardTokens = tokens(awardName).filter(
    (token) => !["award", "awards", "fellowship", "fellowships", "scholarship", "scholarships", "program"].includes(token),
  );

  return links
    .map((link) => {
      const linkUrl = new URL(link.url);
      const lower = `${link.url} ${link.title}`.toLowerCase();
      const pageType = classifyPageType(link.url, link.title);
      const sameProgramArea = sourceDirectory !== "/" && linkUrl.pathname.toLowerCase().startsWith(sourceDirectory);
      const relatedSubdomain = linkUrl.hostname !== sourceUrl.hostname && isRelatedHost(linkUrl.hostname, sourceUrl.hostname);
      const officialExternalFromInstitution =
        sourceIsInstitutionalDiscovery && isLikelyOfficialExternalLink(linkUrl, link.title, sourceUrl);
      const awardTokenHits = awardTokens.filter((token) => lower.includes(token)).length;
      if (
        isGenericOrganizationLink(linkUrl, link.title) &&
        !sameProgramArea &&
        !officialExternalFromInstitution
      ) {
        return null;
      }

      let score = pageType === "other" ? 0 : 5;
      if (sameProgramArea) score += 4;
      if (relatedSubdomain) score += 3;
      if (officialExternalFromInstitution) score += 8;
      score += awardTokenHits * 2;
      if (/\b(overview|information)\b/.test(lower)) score += 2;
      if (/\b(advice|guidance|references?|recommendation|faculty|reps?|scholars?|alumni)\b/.test(lower)) score += 3;
      if (/\b(criteria|materials|documents|pdf)\b/.test(lower)) score += 2;
      if (lower.includes("apply")) score += 3;
      if (lower.includes("deadline")) score += 3;
      if (lower.includes("important dates")) score += 3;
      if (lower.includes("eligib")) score += 3;
      if (lower.includes("requirement")) score += 3;
      if (lower.includes("faq")) score += 2;
      if (lower.includes(".pdf")) score += 2;

      return {
        ...link,
        pageType:
          officialExternalFromInstitution && pageType === "other" ? "homepage" : pageType,
        score,
        confidence: Math.min(0.85, 0.45 + score / 20),
      };
    })
    .filter(Boolean)
    .filter((link) => link.score >= 4 && (link.pageType !== "other" || link.score >= 8))
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length);
}

function classifyPageType(url, title) {
  const lower = `${url} ${title}`.toLowerCase();
  if (new URL(url).pathname.toLowerCase().endsWith(".pdf")) return "pdf";
  if (/(deadline|dates?|timeline|cycle)/.test(lower)) return "deadline";
  if (/(apply|application|portal|nomination|faculty|references?|recommendation|advice|guidance)/.test(lower)) return "application";
  if (/(eligib|who-can-apply)/.test(lower)) return "eligibility";
  if (/(requirement|criteria|materials|documents)/.test(lower)) return "requirements";
  if (/(faq|questions)/.test(lower)) return "faq";
  return "other";
}

function isGenericOrganizationLink(url, title) {
  const lower = `${url.pathname} ${title}`.toLowerCase();
  return /(^|\/)(about|author|blog|board|careers?|code-of-conduct|contact|connect|donate|events?|footer|give|home|impact|jobs?|leadership|locations?|media|membership|news|newsroom|press|privacy|publications|staff|support|terms|topics|training)(\/|$|-|\s)/.test(lower) ||
    /\b(about us|board of directors|contact us|give now|join|leadership|membership|national staff|partner with|privacy|terms and conditions|website terms)\b/.test(lower);
}

async function getSharedSnapshotByHash(sharedAwardId, sourceUrl, hash) {
  const { data, error } = await supabase
    .from("shared_award_source_snapshots")
    .select("id, text_sample")
    .eq("shared_award_id", sharedAwardId)
    .eq("source_url", sourceUrl)
    .eq("hash", hash)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertSharedSnapshot(source, content) {
  const { data, error } = await supabase
    .from("shared_award_source_snapshots")
    .upsert(
      {
        shared_award_id: source.shared_award_id,
        shared_award_source_id: source.id,
        source_url: source.url,
        source_title: source.title,
        source_page_type: source.page_type,
        hash: content.hash,
        text_sample: content.sample,
        byte_length: content.byteLength,
        status_code: content.statusCode,
        content_type: content.contentType,
        created_at: new Date().toISOString(),
      },
      {
        onConflict: "shared_award_id,source_url,hash",
        ignoreDuplicates: true,
      },
    )
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  const { data: existing, error: existingError } = await supabase
    .from("shared_award_source_snapshots")
    .select("id, text_sample")
    .eq("shared_award_id", source.shared_award_id)
    .eq("source_url", source.url)
    .eq("hash", content.hash)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing && existing.text_sample !== content.sample) {
    const { error: refreshError } = await supabase
      .from("shared_award_source_snapshots")
      .update({
        shared_award_source_id: source.id,
        source_title: source.title,
        source_page_type: source.page_type,
        text_sample: content.sample,
        byte_length: content.byteLength,
        status_code: content.statusCode,
        content_type: content.contentType,
      })
      .eq("id", existing.id);
    if (refreshError) throw refreshError;
  }
  return existing;
}

function summarizeChange(previousSample, nextText) {
  if (!previousSample) {
    return "Initial award page snapshot captured. Future deadline, eligibility, or document updates will trigger alerts.";
  }

  const previousClean = normalizeText(previousSample);
  const nextClean = normalizeText(nextText);

  if (isLikelySampleExpansion(previousClean, nextClean)) {
    return "No award-relevant wording changed in the stored excerpt.";
  }

  const applicationStatus = applicationOpenStatusChange(previousClean, nextClean);
  if (applicationStatus) return applicationStatus.summary;

  const previousAmounts = new Set(contextualMoneyPhrases(previousClean));
  const newAmounts = unique(contextualMoneyPhrases(nextClean).filter((amount) => !previousAmounts.has(amount))).slice(0, 3);
  if (newAmounts.length > 0) return "New funding amount language appeared: " + newAmounts.join(", ") + ".";

  const previousDates = new Set(contextualDatePhrases(previousClean));
  const newDates = unique(contextualDatePhrases(nextClean).filter((date) => !previousDates.has(date))).slice(0, 4);
  if (newDates.length > 0) {
    const contextualDateSentence = sentenceWithRelevantDate(nextClean, newDates);
    if (contextualDateSentence) return "Added date context: " + contextualDateSentence;
  }

  const addedSentences = changedSentences(previousClean, nextClean, "added");
  if (addedSentences.length > 0) return sentenceSummary("Added text includes", addedSentences);

  const removedSentences = changedSentences(previousClean, nextClean, "removed");
  if (removedSentences.length > 0) return sentenceSummary("Removed text includes", removedSentences);

  const excerpt = changedTextExcerpt(previousClean, nextClean);
  if (excerpt) return excerpt;

  const previousWords = new Set(words(previousSample));
  const additions = unique(
    words(nextText)
      .filter((word) => !previousWords.has(word))
      .filter(isUsefulWordAddition),
  ).slice(0, 12);
  if (!additions.length) return "No award-relevant wording changed in the stored excerpt.";
  return "New terms found: " + additions.join(", ") + ".";
}

function buildChangePromptContext(previousSample, nextText) {
  if (!previousSample) return "Initial snapshot; no previous page text was stored.";

  const previousClean = normalizeText(previousSample);
  const nextClean = normalizeText(nextText);
  const addedSentences = changedSentences(previousClean, nextClean, "added").slice(0, 4);
  const removedSentences = changedSentences(previousClean, nextClean, "removed").slice(0, 3);
  const excerpt = changedTextExcerpt(previousClean, nextClean);
  const applicationStatus = applicationOpenStatusChange(previousClean, nextClean);

  return [
    applicationStatus ? "Application status changed:\n- Before: " + applicationStatus.before + "\n- After: " + applicationStatus.after : "",
    addedSentences.length ? "Added sentences:\n- " + addedSentences.join("\n- ") : "",
    removedSentences.length ? "Removed sentences:\n- " + removedSentences.join("\n- ") : "",
    excerpt ? "Character-level diff: " + excerpt : "",
  ]
    .filter(Boolean)
    .join("\n\n") || "No concise text-level diff was found in the stored excerpt.";
}

function changedSentences(previousText, nextText, mode) {
  const previousSentences = sentenceCandidates(previousText);
  const nextSentences = sentenceCandidates(nextText);
  const previousKeys = new Set(previousSentences.map(sentenceKey));
  const nextKeys = new Set(nextSentences.map(sentenceKey));
  const source = mode === "added" ? nextSentences : previousSentences;
  const comparison = mode === "added" ? previousKeys : nextKeys;
  const comparisonTextKey = " " + sentenceKey(mode === "added" ? previousText : nextText) + " ";
  const comparisonCompactTextKey = compactSentenceKey(mode === "added" ? previousText : nextText);

  return source
    .filter((sentence) => !comparison.has(sentenceKey(sentence)))
    .filter((sentence) => !comparisonTextKey.includes(" " + sentenceKey(sentence) + " "))
    .filter((sentence) => !comparisonContainsCompactSentence(comparisonCompactTextKey, sentence))
    .filter(isUsefulSentence)
    .slice(0, 3);
}

function applicationOpenStatusChange(previousText, nextText) {
  const after = firstTextMatch(nextText, [
    /\bApplications?\s+for\s+[^.]{0,180}?\s+are\s+now\s+open\./i,
    /\bApplications?\s+are\s+now\s+open\./i,
  ]);
  if (!after) return null;

  const beforeParts = [
    firstTextMatch(previousText, [
      /\bApplications?\s+for\s+[^.]{0,180}?\s+are\s+now\s+closed\./i,
      /\bApplications?\s+are\s+now\s+closed\./i,
    ]),
    firstTextMatch(previousText, [
      /\bThe\s+\d{4}\s+applications?\s+will\s+open\s+[^.]+\./i,
      /\bApplications?\s+will\s+open\s+[^.]+\./i,
    ]),
  ].filter(Boolean);

  if (!beforeParts.length) return null;

  return {
    before: unique(beforeParts).join(" "),
    after,
    summary: "The application page now says applications are open: " + after,
  };
}

function firstTextMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = normalizeText(text || "").match(pattern);
    if (match?.[0]) return truncateSnippet(match[0], 260);
  }
  return null;
}

function sentenceCandidates(text) {
  return splitChangeSentences(normalizeText(text))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 35 && sentence.length <= 320);
}

function splitChangeSentences(text) {
  return protectSentenceAbbreviations(text)
    .split(/(?<=[.!?])\s+|(?<=:)\s+(?=[A-Z0-9])/)
    .map(restoreSentenceAbbreviations);
}

function protectSentenceAbbreviations(value) {
  return String(value || "")
    .replace(/\bM\.\s*D\./g, "M" + sentenceDotPlaceholder + "D" + sentenceDotPlaceholder)
    .replace(/\bPh\.\s*D\./gi, "Ph" + sentenceDotPlaceholder + "D" + sentenceDotPlaceholder)
    .replace(/\bU\.\s*S\./g, "U" + sentenceDotPlaceholder + "S" + sentenceDotPlaceholder)
    .replace(/\bU\.\s*K\./g, "U" + sentenceDotPlaceholder + "K" + sentenceDotPlaceholder)
    .replace(/\bi\.\s*e\./gi, "i" + sentenceDotPlaceholder + "e" + sentenceDotPlaceholder)
    .replace(/\be\.\s*g\./gi, "e" + sentenceDotPlaceholder + "g" + sentenceDotPlaceholder);
}

function restoreSentenceAbbreviations(value) {
  return value.replaceAll(sentenceDotPlaceholder, ".");
}

function sentenceKey(sentence) {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactSentenceKey(sentence) {
  return sentence.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function comparisonContainsCompactSentence(comparisonCompactTextKey, sentence) {
  const compactKey = compactSentenceKey(sentence);
  return compactKey.length >= 40 && comparisonCompactTextKey.includes(compactKey);
}

function isUsefulSentence(sentence) {
  const lower = sentence.toLowerCase();
  if (isBoilerplateOrNavigationText(sentence)) return false;
  if (isNewsOrMarketingText(sentence)) return false;
  const meaningfulTerms = /\b(applications?|apply|deadline|eligible|eligibility|requirements?|recommendations?|transcripts?|essays?|interviews?|tuition|stipend|funding|fellows?|fellowship|scholarships?|awards?|admissions?|selection|nomination|candidates?|program|internship|grant|submit|submission|citizenship|gpa)\b/.test(lower);
  return meaningfulTerms;
}

function sentenceWithRelevantDate(text, dates) {
  const dateSet = new Set(dates.map((date) => date.toLowerCase()));
  return sentenceCandidates(text)
    .filter((sentence) =>
      datePhrases(sentence).some((date) => dateSet.has(date.toLowerCase())),
    )
    .find((sentence) => isAwardDateContext(sentence));
}

function isAwardDateContext(sentence) {
  const lower = sentence.toLowerCase();
  if (/(latest news|news|blog|story|stories|read more|published|press release|past recipients?|received the .* award|receives the .* award|photo by|getty images)/.test(lower)) {
    return false;
  }

  return /\b(deadline|due|application|apply|opens?|closes?|timeline|round|eligible|eligibility|interview|selection|notification|nomination|submit|submission)\b/.test(
    lower,
  );
}

function sentenceSummary(prefix, sentences) {
  const snippets = sentences.slice(0, 2).map((sentence) => "\"" + truncateSnippet(sentence, 220) + "\"");
  return prefix + ": " + snippets.join("; ") + ".";
}

function changedTextExcerpt(previousText, nextText) {
  if (!previousText || !nextText || previousText === nextText) return null;

  if (isLikelySampleExpansion(previousText, nextText)) {
    return "No award-relevant wording changed in the stored excerpt.";
  }

  const prefixLength = commonPrefixLength(previousText, nextText);
  const suffixLength = commonSuffixLength(previousText.slice(prefixLength), nextText.slice(prefixLength));
  const previousChanged = previousText.slice(prefixLength, previousText.length - suffixLength);
  const nextChanged = nextText.slice(prefixLength, nextText.length - suffixLength);
  const removed = truncateSnippet(previousChanged, 180);
  const added = truncateSnippet(nextChanged, 220);

  if (isNewsOrMarketingText(added) || isBoilerplateOrNavigationText(added)) return null;

  if (added.length >= 25 && removed.length >= 25) return "Changed text from \"" + removed + "\" to \"" + added + "\".";
  if (added.length >= 25) return "Added text includes: \"" + added + "\".";
  if (removed.length >= 25) return "Removed text includes: \"" + removed + "\".";
  return null;
}

function commonPrefixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[left.length - 1 - index] === right[right.length - 1 - index]) index += 1;
  return index;
}

function truncateSnippet(value, maxLength) {
  const clean = normalizeText(value).replace(/^[-:;,.\s]+/, "").replace(/[-:;,\s]+$/, "");
  if (clean.length <= maxLength) return clean;
  const truncated = clean.slice(0, maxLength + 1);
  const boundary = truncated.lastIndexOf(" ");
  return truncated.slice(0, boundary > 80 ? boundary : maxLength).trim() + "...";
}

async function buildChangeDetailsForSource(source, previousSample, nextText) {
  const fallbackSummary = cleanWorkerSummaryForSource(
    source,
    summarizeChange(previousSample, nextText),
  );
  const fallback = buildWorkerFallbackChangeDetails(
    source,
    previousSample,
    nextText,
    fallbackSummary,
  );

  if (!aiSummaries || !previousSample || !fallback.is_alert_worthy) return fallback;

  if (aiSummaryProvider === "gemini") {
    return summarizeChangeDetailsWithGemini(source, previousSample, nextText, fallback);
  }

  if (aiSummaryProvider === "openai") {
    return summarizeChangeDetailsWithOpenAI(source, previousSample, nextText, fallback);
  }

  return fallback;
}

function buildWorkerFallbackChangeDetails(source, previousSample, nextText, fallbackSummary) {
  const structuredDiff = buildWorkerStructuredDiff(source, previousSample, nextText);
  const legacySnippets = workerLegacySummarySnippets(fallbackSummary);
  const before = structuredDiff.removed_text[0] || legacySnippets.before;
  const after = structuredDiff.added_text[0] || legacySnippets.after;
  const changeType = inferWorkerChangeType(structuredDiff, fallbackSummary);
  const contentRotation = workerProfileTestimonialChangeSummary(source, structuredDiff);
  const qualityFlags = workerQualityFlags({
    reader_summary: contentRotation?.summary || fallbackSummary,
    before,
    after,
    structured_diff: structuredDiff,
  });
  const isAlertWorthy = !hasHardQualityFlag(qualityFlags);

  return {
    reader_summary: isAlertWorthy
      ? contentRotation?.summary || fallbackSummary
      : "No award-relevant wording changed in the stored excerpt.",
    before: isAlertWorthy ? before : null,
    after: isAlertWorthy ? after : null,
    section: structuredDiff.likely_section,
    change_type: isAlertWorthy ? contentRotation?.changeType || changeType : "noise",
    advisor_impact: isAlertWorthy
      ? contentRotation?.advisorImpact || workerAdvisorImpact(changeType, structuredDiff)
      : null,
    is_alert_worthy: isAlertWorthy,
    confidence: isAlertWorthy ? workerConfidence(structuredDiff, previousSample) : "low",
    structured_diff: structuredDiff,
    source: workerChangeSource(source),
    quality_flags: qualityFlags,
    generated_at: new Date().toISOString(),
    generation_provider: "heuristic",
    generation_status: isAlertWorthy ? "generated" : "rejected",
    generation_model: null,
  };
}

function workerLegacySummarySnippets(summary) {
  const changed = String(summary || "").match(/changed text from\s+"([^"]+)"\s+to\s+"([^"]+)"/i);
  if (changed) return { before: changed[1], after: changed[2] };

  const added = String(summary || "").match(/(?:added text includes|new text appears after the previously stored excerpt):\s+"([^"]+)"/i);
  if (added) return { before: null, after: added[1] };

  const removed = String(summary || "").match(/removed text includes:\s+"([^"]+)"/i);
  if (removed) return { before: removed[1], after: null };

  const narrativeAdded = String(summary || "").match(/added the following wording:\s+(.+)$/i);
  if (narrativeAdded) return { before: null, after: narrativeAdded[1] };

  const narrativeRemoved = String(summary || "").match(/removed the following wording:\s+(.+)$/i);
  if (narrativeRemoved) return { before: narrativeRemoved[1], after: null };

  return { before: null, after: null };
}

function buildWorkerStructuredDiff(source, previousSample, nextText) {
  const previousClean = normalizeText(previousSample || "");
  const nextClean = normalizeText(nextText || "");
  const applicationStatus = previousClean ? applicationOpenStatusChange(previousClean, nextClean) : null;
  const addedText = previousClean
    ? unique([
        applicationStatus?.after,
        ...changedSentences(previousClean, nextClean, "added").slice(0, 5),
      ].filter(Boolean))
    : [];
  const removedText = previousClean
    ? unique([
        applicationStatus?.before,
        ...changedSentences(previousClean, nextClean, "removed").slice(0, 4),
      ].filter(Boolean))
    : [];
  const previousDates = new Set(contextualDatePhrases(previousClean));
  const nextDates = new Set(contextualDatePhrases(nextClean));
  const previousAmounts = new Set(contextualMoneyPhrases(previousClean));
  const nextAmounts = new Set(contextualMoneyPhrases(nextClean));
  const addedDates = [...nextDates].filter((date) => !previousDates.has(date));
  const removedDates = [...previousDates].filter((date) => !nextDates.has(date));
  const addedAmounts = [...nextAmounts].filter((amount) => !previousAmounts.has(amount));
  const removedAmounts = [...previousAmounts].filter((amount) => !nextAmounts.has(amount));
  const noiseFlags = [];
  const sampleExpansion = isLikelySampleExpansion(previousClean, nextClean);
  const changedText = [...addedText, ...removedText].join(" ");

  if (!previousClean) noiseFlags.push("no_previous_snapshot");
  if (looksLikeSourceAccessError(previousClean) || looksLikeSourceAccessError(nextClean)) {
    noiseFlags.push("source_access_error");
  }
  if (sampleExpansion) noiseFlags.push("sample_expansion");
  if (hasRawScrapeSignals(changedText)) noiseFlags.push("raw_scrape_signal");
  if (looksLikeOrphanPunctuation(changedText)) noiseFlags.push("orphan_punctuation");
  if (
    !addedText.length &&
    !removedText.length &&
    !addedDates.length &&
    !removedDates.length &&
    !addedAmounts.length &&
    !removedAmounts.length
  ) {
    noiseFlags.push("no_actual_changed_fact");
  }

  return {
    added_text: addedText,
    removed_text: removedText,
    likely_section: inferWorkerSection(addedText[0] || removedText[0] || source.title || "", source),
    page_type: source.page_type || null,
    date_changes: [
      ...addedDates.map((date) => "Added " + date),
      ...removedDates.map((date) => "Removed " + date),
    ],
    amount_changes: [
      ...addedAmounts.map((amount) => "Added " + amount),
      ...removedAmounts.map((amount) => "Removed " + amount),
    ],
    noise_flags: unique(noiseFlags),
  };
}

async function summarizeChangeDetailsWithOpenAI(source, previousSample, nextText, fallback) {
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.OPENAI_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_SUMMARY_MODEL || env.OPENAI_DISCOVERY_MODEL || "gpt-4.1-mini",
        instructions: structuredChangeSystemPrompt(),
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: structuredChangeUserPrompt(source, previousSample, nextText, fallback),
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_object",
          },
        },
        max_output_tokens: 700,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const model = env.OPENAI_SUMMARY_MODEL || env.OPENAI_DISCOVERY_MODEL || "gpt-4.1-mini";
    if (!response.ok) return withWorkerGenerationMetadata(fallback, "openai", "fallback", model);
    const data = await response.json();
    return normalizeWorkerAiChangeDetails(extractResponseText(data), fallback, nextText, source, "openai", model);
  } catch {
    return withWorkerGenerationMetadata(
      fallback,
      "openai",
      "fallback",
      env.OPENAI_SUMMARY_MODEL || env.OPENAI_DISCOVERY_MODEL || "gpt-4.1-mini",
    );
  }
}

async function summarizeChangeDetailsWithGemini(source, previousSample, nextText, fallback) {
  try {
    const model = env.GEMINI_SUMMARY_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash";
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(model) +
        ":generateContent?key=" +
        encodeURIComponent(env.GEMINI_API_KEY),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: structuredChangeSystemPrompt() }],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: structuredChangeUserPrompt(source, previousSample, nextText, fallback),
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 700,
            responseMimeType: "application/json",
            responseSchema: workerChangeDetailsResponseSchema(),
          },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!response.ok) return withWorkerGenerationMetadata(fallback, "gemini", "fallback", model);
    const data = await response.json();
    return normalizeWorkerAiChangeDetails(
      extractGeminiText(data),
      fallback,
      nextText,
      source,
      "gemini",
      model,
    );
  } catch {
    return withWorkerGenerationMetadata(
      fallback,
      "gemini",
      "fallback",
      env.GEMINI_SUMMARY_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash",
    );
  }
}

function structuredChangeSystemPrompt() {
  return [
    "You summarize official award webpage changes for scholarship advisors.",
    "Return valid JSON only, with no markdown.",
    "Use only facts visible in the previous excerpt, new excerpt, and structured diff.",
    "Ignore navigation, footers, social links, CTAs, testimonials, unrelated programs, and raw scrape artifacts.",
    "If either excerpt is an error, access denied, forbidden, not found, or other source access page, set is_alert_worthy=false.",
    "If the only change is rotating testimonials, fellows, recipients, speaker bios, staff/team rosters, or profile/story text, keep it as a low-impact content_update and summarize the category of content that changed instead of quoting the text.",
    "Reject raw scrape signals such as LEARN MORE and vague page-update language.",
    "Required keys: reader_summary, before, after, section, change_type, advisor_impact, is_alert_worthy, confidence.",
    "Use null for unknown before, after, section, or advisor_impact.",
    "Set is_alert_worthy=false when no concrete award-relevant fact changed.",
    "Make reader_summary a clear one- or two-sentence explanation for a scholarship advisor.",
    "For broad content rotations, describe the category of content that changed and explicitly say whether deadlines, eligibility, funding, or application requirements changed.",
    "For concrete award changes, state the practical before/after meaning instead of dumping raw scraped text.",
    "confidence must be low, medium, or high.",
  ].join(" ");
}

function structuredChangeUserPrompt(source, previousSample, nextText, fallback) {
  return [
    "Award: " + (source.shared_awards?.name || "Unknown award"),
    "Source title: " + (source.title || "Unknown source"),
    "Source URL: " + (source.url || "Unknown URL"),
    "Page type: " + (source.page_type || "unknown"),
    "",
    "Structured diff candidates:",
    JSON.stringify(fallback.structured_diff),
    "",
    "Fallback JSON to improve if possible:",
    JSON.stringify({
      reader_summary: fallback.reader_summary,
      before: fallback.before,
      after: fallback.after,
      section: fallback.section,
      change_type: fallback.change_type,
      advisor_impact: fallback.advisor_impact,
      is_alert_worthy: fallback.is_alert_worthy,
      confidence: fallback.confidence,
    }),
    "",
    "Diff context:\n" + buildChangePromptContext(previousSample, nextText),
    "",
    "Previous excerpt:\n" + previousSample.slice(0, summaryPromptChars),
    "",
    "New excerpt:\n" + nextText.slice(0, summaryPromptChars),
    "",
    "Return one JSON object. The reader_summary must explain the changed fact directly, not as a scrape fragment or word-level diff.",
  ].join("\n");
}

function normalizeWorkerAiChangeDetails(text, fallback, nextText, source, provider, model) {
  const parsed = parseJsonObjectFromText(text);
  if (!parsed) {
    return withWorkerGenerationMetadata(
      addWorkerQualityFlag(fallback, "ai_invalid_json"),
      provider,
      "invalid_json",
      model,
    );
  }

  const readerSummary = cleanAiSummary(parsed.reader_summary, fallback.reader_summary, nextText, source);
  const candidate = refineWorkerContentOnlyChange({
    reader_summary: readerSummary,
    before: cleanNullableText(parsed.before) || fallback.before,
    after: cleanNullableText(parsed.after) || fallback.after,
    section: cleanNullableText(parsed.section) || fallback.section,
    change_type: cleanSlugText(parsed.change_type) || fallback.change_type,
    advisor_impact: cleanNullableText(parsed.advisor_impact) || fallback.advisor_impact,
    is_alert_worthy: typeof parsed.is_alert_worthy === "boolean" ? parsed.is_alert_worthy : fallback.is_alert_worthy,
    confidence: normalizeWorkerConfidence(parsed.confidence) || fallback.confidence,
    structured_diff: fallback.structured_diff,
    source: workerChangeSource(source),
    quality_flags: [],
    generated_at: new Date().toISOString(),
    generation_provider: provider,
    generation_status: "generated",
    generation_model: model,
  });
  candidate.quality_flags = workerQualityFlags(candidate);

  if (!candidate.is_alert_worthy || hasHardQualityFlag(candidate.quality_flags)) {
    return withWorkerGenerationMetadata(
      addWorkerQualityFlag(fallback, "ai_rejected"),
      provider,
      "rejected",
      model,
    );
  }

  return candidate;
}

function parseJsonObjectFromText(text) {
  const clean = normalizeText(String(text || "")).replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/i, "");
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

function workerQualityFlags(details) {
  const flags = [...(details.structured_diff?.noise_flags || [])];
  const text = [
    details.reader_summary,
    details.before,
    details.after,
    details.section,
    details.advisor_impact,
  ].filter(Boolean).join(" ");

  if (hasRawScrapeSignals(text)) flags.push("raw_scrape_signal");
  if (looksLikeOrphanPunctuation(details.reader_summary)) flags.push("orphan_punctuation");
  if (isVagueSummary(details.reader_summary)) flags.push("vague_summary");
  if (looksLikeWorkerProfileOrTestimonialRotation(details.structured_diff)) {
    flags.push("profile_testimonial_change");
  }
  if (hasIndistinctWorkerTruncatedSnippets(details.before, details.after)) {
    flags.push("indistinct_truncated_snippet");
  }
  if (hasWorkerFormatOnlySnippetChange(details.before, details.after)) {
    flags.push("format_only_change");
  }
  if (hasWorkerContextOnlySnippetChange(details)) {
    flags.push("context_only_change");
  }
  if (
    !details.before &&
    !details.after &&
    !details.structured_diff?.date_changes?.length &&
    !details.structured_diff?.amount_changes?.length
  ) {
    flags.push("no_actual_changed_fact");
  }
  if (hasUnsupportedWorkerStructuredFact(details)) flags.push("unsupported_structured_fact");

  return unique(flags);
}

function hasHardQualityFlag(flags) {
  return flags.some((flag) =>
    ["ai_invalid_json", "source_access_error", "raw_scrape_signal", "orphan_punctuation", "vague_summary", "no_actual_changed_fact", "sample_expansion", "unsupported_structured_fact", "indistinct_truncated_snippet", "format_only_change", "context_only_change"].includes(flag),
  );
}

function hasIndistinctWorkerTruncatedSnippets(before, after) {
  if (!before || !after) return false;
  const cleanBefore = normalizeWorkerComparableSnippet(before);
  const cleanAfter = normalizeWorkerComparableSnippet(after);
  if (!cleanBefore || !cleanAfter) return false;
  if (cleanBefore === cleanAfter) return true;
  const shorter = cleanBefore.length <= cleanAfter.length ? cleanBefore : cleanAfter;
  const longer = cleanBefore.length > cleanAfter.length ? cleanBefore : cleanAfter;
  if (shorter.length >= 160 && longer.startsWith(shorter.slice(0, 160))) {
    return true;
  }
  return shorter.length >= 40 && longer.startsWith(shorter) && looksLikeIncompleteWorkerPrefixSnippet(shorter);
}

function normalizeWorkerComparableSnippet(value) {
  return normalizeText(String(value || "")).replace(/\.\.\.$/, "").replace(/[.。]+$/g, "").toLowerCase();
}

function looksLikeIncompleteWorkerPrefixSnippet(value) {
  const clean = normalizeText(String(value || "")).replace(/\.\.\.$/, "").trim();
  if (!clean) return false;
  if (/[.!?)]["']?$/.test(clean)) return false;
  if (/\$\s?\d|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\b/i.test(clean)) {
    return false;
  }
  return (clean.match(/[a-z0-9]+/gi) || []).length >= 5;
}

function hasWorkerFormatOnlySnippetChange(before, after) {
  if (!before || !after) return false;
  const cleanBefore = normalizeWorkerComparableSnippet(before);
  const cleanAfter = normalizeWorkerComparableSnippet(after);
  if (!cleanBefore || !cleanAfter || cleanBefore === cleanAfter) return false;
  if (compactWorkerComparableSnippet(cleanBefore) === compactWorkerComparableSnippet(cleanAfter)) return true;
  if (!containsWorkerMonthDay(cleanBefore) || !containsWorkerMonthDay(cleanAfter)) return false;
  return normalizeWorkerDateFormattingSnippet(cleanBefore) === normalizeWorkerDateFormattingSnippet(cleanAfter);
}

function compactWorkerComparableSnippet(value) {
  return String(value || "").replace(/[^a-z0-9]+/g, "");
}

function normalizeWorkerDateFormattingSnippet(value) {
  const month = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  return String(value || "")
    .replace(new RegExp(`\\b(${month})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)\\b`, "gi"), "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/[.!?;:,\s]+$/g, "")
    .trim();
}

function containsWorkerMonthDay(value) {
  return /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(String(value || ""));
}

function hasUnsupportedWorkerStructuredFact(details) {
  const diff = details.structured_diff || {};
  const evidenceText = [
    details.before,
    details.after,
    ...(diff.added_text || []),
    ...(diff.removed_text || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const amountFacts = (diff.amount_changes || []).flatMap(workerMoneyFactPhrases);
  if (amountFacts.some((fact) => !evidenceText.includes(fact))) return true;

  return (diff.date_changes || [])
    .flatMap(workerDateFactPhrases)
    .some((fact) => !evidenceText.includes(fact));
}

function workerMoneyFactPhrases(value) {
  return unique(
    [...normalizeText(value).matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?\b/g)]
      .map((match) => normalizeText(match[0]).toLowerCase())
      .filter(Boolean),
  );
}

function workerDateFactPhrases(value) {
  const clean = normalizeText(String(value || "").replace(/^(Added|Removed)\s+/i, ""));
  const month = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const monthYear = new RegExp("\\b(?:" + month + ")\\.?\\s+\\d{4}\\b", "gi");
  return unique([...datePhrases(clean), ...[...clean.matchAll(monthYear)].map((match) => normalizeText(match[0]))])
    .map((date) => date.toLowerCase())
    .filter(Boolean);
}

function hasWorkerContextOnlySnippetChange(details) {
  const diff = details.structured_diff || {};
  if (!details.before || !details.after) return false;
  if (diff.date_changes?.length || diff.amount_changes?.length) return false;

  const pageType = cleanSlugText(diff.page_type || details.source?.page_type);
  if (/^(application|deadline|eligibility|requirements?)$/.test(pageType)) return false;

  const before = normalizeWorkerComparableSnippet(details.before);
  const after = normalizeWorkerComparableSnippet(details.after);
  if (!before || !after || before === after) return false;

  const shorter = before.length <= after.length ? before : after;
  const longer = before.length > after.length ? before : after;
  if (shorter.length < 55 || !longer.includes(shorter)) return false;

  const extra = normalizeText(longer.replace(shorter, " "));
  if (extra.length < 24) return false;
  if (hasWorkerApplicationRequirementSignal(extra) || hasFundingAmountContext(extra)) return false;

  const sourceContext = `${details.source?.source_title || ""} ${details.section || ""}`.toLowerCase();
  return (
    pageType === "other" ||
    pageType === "homepage" ||
    /\b(recognition|news|story|stories|events?|donors?|sponsors?|partners?|press|profiles?|past recipients?)\b/.test(sourceContext)
  );
}

function addWorkerQualityFlag(details, flag) {
  return {
    ...details,
    quality_flags: unique([...(details.quality_flags || []), flag]),
  };
}

function withWorkerGenerationMetadata(details, provider, status, model) {
  return {
    ...details,
    generation_provider: provider,
    generation_status: status,
    generation_model: model,
  };
}

function workerChangeDetailsResponseSchema() {
  return {
    type: "object",
    properties: {
      reader_summary: { type: "string" },
      before: { type: "string", nullable: true },
      after: { type: "string", nullable: true },
      section: { type: "string", nullable: true },
      change_type: { type: "string" },
      advisor_impact: { type: "string", nullable: true },
      is_alert_worthy: { type: "boolean" },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      quality_flags: { type: "array", items: { type: "string" } },
    },
    required: [
      "reader_summary",
      "before",
      "after",
      "section",
      "change_type",
      "advisor_impact",
      "is_alert_worthy",
      "confidence",
    ],
  };
}

function inferWorkerChangeType(diff, summary) {
  const haystack = [
    summary,
    ...diff.added_text,
    ...diff.removed_text,
    ...diff.date_changes,
    ...diff.amount_changes,
  ].join(" ").toLowerCase();

  if (diff.amount_changes.length || /\b(funding|stipend|tuition|fellowships? will be awarded|award amount|amount awarded)\b/.test(haystack)) return "funding";
  if (diff.date_changes.length || /\b(deadline|due|opens?|closes?|date)\b/.test(haystack)) return "deadline";
  if (/\b(eligible|eligibility|citizenship|gpa|enrolled)\b/.test(haystack)) return "eligibility";
  if (/\b(apply|application|submit|submission|recommendation|transcript|essay)\b/.test(haystack)) return "application";
  if (/\b(pdf|guide|handbook|instructions|document)\b/.test(haystack)) return "document";
  if (looksLikeWorkerProfileOrTestimonialRotation(diff)) return "content_update";
  if (diff.removed_text.length && !diff.added_text.length) return "removed_text";
  if (diff.added_text.length) return "new_text";
  return "other";
}

function refineWorkerContentOnlyChange(details) {
  const contentRotation = workerProfileTestimonialChangeSummary(
    {
      title: details.source?.source_title,
      url: details.source?.source_url,
      page_type: details.source?.page_type,
      shared_awards: { name: details.source?.award_name },
    },
    details.structured_diff,
  );
  if (!contentRotation) return details;

  return {
    ...details,
    reader_summary: contentRotation.summary,
    change_type: contentRotation.changeType,
    advisor_impact: contentRotation.advisorImpact,
    confidence: details.confidence === "high" ? "medium" : details.confidence,
  };
}

function workerProfileTestimonialChangeSummary(source, diff) {
  if (!looksLikeWorkerProfileOrTestimonialRotation(diff)) return null;
  const sourceName = source.title || source.shared_awards?.name || "source";
  return {
    summary: `The ${sourceName} page refreshed profile, testimonial, or roster content; no application requirements, deadlines, eligibility, or funding text changed.`,
    changeType: "content_update",
    advisorImpact:
      "No applicant-facing action is likely needed unless this page is used in promotional or reference materials.",
  };
}

function looksLikeWorkerProfileOrTestimonialRotation(diff) {
  if (!diff || diff.date_changes?.length || diff.amount_changes?.length) return false;
  const changed = `${(diff.added_text || []).join(" ")} ${(diff.removed_text || []).join(" ")}`;
  if (!looksLikeWorkerProfileOrTestimonialRotationText(changed)) return false;
  if (hasWorkerApplicationRequirementSignal(changed)) return false;
  return Boolean(diff.added_text?.length || diff.removed_text?.length);
}

function looksLikeWorkerProfileOrTestimonialRotationText(value) {
  const clean = normalizeText(value);
  if (!clean) return false;
  const quoteSignals = (clean.match(/[“”"]/g) || []).length >= 2;
  const personSignals = /\b(fellow|scholar|recipient|alum(?:na|ni|nus)?|student|teacher|professor|faculty|speaker|bio|biography|profile|testimonial|quote)\b/i.test(clean);
  const storySignals = /\b(earned an? ma|earned an? m\.?a\.?|earned an? master's|teaches at|i am proud|i've made|my fellowship|my career|learned from colleagues|honored to be teaching|profile|testimonial)\b/i.test(clean);
  const rosterSignals = /\b(our team|staff|leadership|board of trustees|steering group members?|senior fellow|director|co-?director|specialist|researcher|members?|center for applied linguistics)\b/i.test(clean) && /\b(dr\.|ms\.|mr\.|mrs\.|director|fellow|specialist|professor|researcher)\b/i.test(clean);
  const stateFellowSignals = /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\s+fellow\b/i.test(clean);
  return personSignals && (quoteSignals || storySignals || rosterSignals || stateFellowSignals);
}

function hasWorkerApplicationRequirementSignal(value) {
  return /\b(deadline|due|applications?\s+(?:open|close|due)|apply by|submit(?:ted)? by|eligib(?:le|ility)|must submit|required|requirements?|recommendation|transcript|essay|interview|tuition|stipend|award amount|funding amount|citizenship|gpa)\b/i.test(value);
}

function inferWorkerSection(text, source) {
  const lower = (String(text || "") + " " + String(source.title || "")).toLowerCase();
  if (/\b(deadline|timeline|dates?)\b/.test(lower)) return "Dates and deadlines";
  if (/\b(eligible|eligibility|requirements?)\b/.test(lower)) return "Eligibility";
  if (/\b(apply|application|submit|submission)\b/.test(lower)) return "Application";
  if (/\b(recommendation|transcript|essay|materials?)\b/.test(lower)) return "Materials";
  if (/\b(funding|stipend|tuition|amount)\b/.test(lower)) return "Funding";
  return source.title || null;
}

function workerAdvisorImpact(changeType, diff) {
  if (changeType === "deadline") return "Check office timelines, reminders, and applicant instructions for this date.";
  if (changeType === "funding") return "Check award descriptions and applicant advising materials for this funding amount.";
  if (changeType === "eligibility") return "Review eligibility guidance before advising applicants from this award.";
  if (changeType === "application" || diff.added_text.length || diff.removed_text.length) {
    return "Review applicant instructions for any needed office-facing updates.";
  }
  return null;
}

function workerConfidence(diff, previousSample) {
  if (!previousSample || diff.noise_flags?.includes("sample_expansion")) return "low";
  if (diff.date_changes.length || diff.amount_changes.length) return "high";
  if (diff.added_text.length || diff.removed_text.length) return "medium";
  return "low";
}

function workerChangeSource(source) {
  return {
    award_name: source.shared_awards?.name || null,
    source_title: source.title || null,
    source_url: source.url || null,
    page_type: source.page_type || null,
  };
}

function cleanNullableText(value) {
  const clean = normalizeText(String(value || ""));
  return clean || null;
}

function cleanSlugText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizeWorkerConfidence(value) {
  const clean = cleanSlugText(value);
  return ["low", "medium", "high"].includes(clean) ? clean : null;
}

function hasRawScrapeSignals(value) {
  return (
    looksLikeSourceAccessError(value) ||
    hasRawMarkupSignals(value) ||
    hasSeoInstrumentationSignals(value) ||
    hasJumpLinkHeadingPrefixSignals(value) ||
    /\b(learn more|read more|click here|skip to|main menu|toggle menu|toggle page navigation|search menu|read current issue|cart|dismiss|login|copyright|privacy policy|all rights reserved|facebook|instagram|x\.com|twitter|linkedin|youtube|subscribe|newsletter)\b/i.test(String(value || "")) ||
    hasNavigationBoilerplate(value) ||
    hasStorefrontBoilerplate(value)
  );
}

function looksLikeSourceAccessError(value) {
  const clean = normalizeText(String(value || ""));
  if (!clean) return false;
  return (
    /\b(?:fehler|error)\s*(?:401|403|404|410|429|50[0-4])\b/i.test(clean) ||
    /\b(access denied|zugriff verboten|forbidden|not found|page not found|service unavailable|too many requests)\b/i.test(clean) ||
    /\bthe access to this directory\/page is restricted\b/i.test(clean) ||
    /\bHTTP\/1\.1\s+(?:401|403|404|410|429|50[0-4])\b/i.test(clean)
  );
}

function looksLikeSourceAccessErrorPage(value) {
  const clean = normalizeText(String(value || ""));
  if (!clean) return false;

  const firstChunk = clean.slice(0, 1800);
  const pageErrorSignal =
    /\b(?:fehler|error)\s*(?:401|403|404|410|429|50[0-4])\b/i.test(firstChunk) ||
    /\bHTTP\/1\.1\s+(?:401|403|404|410|429|50[0-4])\b/i.test(firstChunk) ||
    /\b(access denied|zugriff verboten|forbidden|page not found|service unavailable|too many requests)\b/i.test(firstChunk) ||
    /^.{0,160}\bnot found\b/i.test(firstChunk) ||
    /\bthe access to this directory\/page is restricted\b/i.test(firstChunk);

  return (
    pageErrorSignal &&
    (clean.length < 4000 ||
      /^(?:error|fehler|access denied|zugriff verboten|forbidden|not found|page not found|service unavailable|too many requests)\b/i.test(
        firstChunk,
      ) ||
      /\bthe access to this directory\/page is restricted\b/i.test(firstChunk))
  );
}

function looksLikeBrokenDynamicPage(value) {
  const clean = normalizeText(String(value || ""));
  if (!clean) return false;
  return (
    clean.length <= 500 &&
    (/\bloading\b.*\bsorry to interrupt\b.*\bcss error\b.*\brefresh\b/i.test(clean) ||
      /\bplease enable javascript\b/i.test(clean) ||
      /\bchecking your browser before accessing\b/i.test(clean))
  );
}

function looksLikeNonContentStubPage(source, value) {
  const clean = normalizeText(String(value || ""));
  if (!clean) return false;

  const sourceLabel = `${source?.title || ""} ${source?.url || ""}`;
  return (
    (String(source?.page_type || "").toLowerCase() === "pdf" && clean.length < 120) ||
    /^(?:--\s*\d+\s+of\s+\d+\s*--\s*)+$/i.test(clean) ||
    (clean.length < 500 && /\b(site\s*map|sitemap)\b/i.test(sourceLabel))
  );
}

function looksLikeLoginWallPage(value) {
  const clean = normalizeText(String(value || ""));
  if (!clean || clean.length > 1800) return false;

  return (
    /\b(login|log in|sign in|password|forgot your password|two-factor authentication|2FA|saved usernames?)\b/i.test(
      clean,
    ) &&
    /\b(email|username)\b/i.test(clean) &&
    /\bpassword\b/i.test(clean)
  );
}

function hasJumpLinkHeadingPrefixSignals(value) {
  const clean = normalizeText(String(value || ""));
  return /\bTop\s+(?:Applications?|The Selection Process|Selection Process|Eligibility|Requirements?|Deadlines?|Timeline|FAQs?|Funding|References?|Courses?)\b/.test(
    clean,
  );
}

function hasSeoInstrumentationSignals(value) {
  const clean = normalizeText(String(value || ""));
  return (
    /\bbe_ixf\b/i.test(clean) ||
    /\bym_20\d{4}\s+d_\d{2}\b/i.test(clean) ||
    /\bphp_sdk(?:_\d+(?:\.\d+){1,3})?\b/i.test(clean) ||
    /\bct_\d+\s+be_ixf\b/i.test(clean)
  );
}

function hasRawMarkupSignals(value) {
  const clean = normalizeText(String(value || ""));
  return (
    /<\/?(?:picture|source|img|script|style|div|span|section|article|figure|figcaption|a|p|br|ul|ol|li|svg|path)\b/i.test(clean) ||
    /\b(?:srcset|classname|referrerpolicy|loading|sizes|alt|href|style)=["'][^"']{8,}/i.test(clean) ||
    /https?:\/\/[^\s"']+\.(?:jpg|jpeg|png|gif|webp|svg)(?:[?#][^\s"']*)?/i.test(clean)
  );
}

function hasStorefrontBoilerplate(value) {
  const clean = normalizeText(String(value || ""));
  return (
    /\b(view item|featured products?|shop for materials?|add to cart|checkout|subtotal|merchandise)\b/i.test(clean) ||
    /\bprice:\s*\$\s?\d/i.test(clean)
  );
}

function hasNavigationBoilerplate(value) {
  const clean = normalizeText(String(value || ""));
  const lower = clean.toLowerCase();
  const structuralNavMarkers = /\b(primary sidebar|secondary sidebar|sidebar navigation|site navigation|breadcrumb|footer)\b/i.test(
    clean,
  );
  const navTerms = [
    "application overview",
    "eligibility",
    "essays",
    "priorities",
    "selection criteria",
    "submission tips",
    "requirements",
    "deadlines",
    "timeline",
    "applicants faq",
    "current recipients",
    "scholars abroad",
    "alumni",
    "advisors",
    "general inquiries",
  ];
  const navTermCount = navTerms.filter((term) => lower.includes(term)).length;

  if (structuralNavMarkers && navTermCount >= 4) return true;

  return (
    /\b(back|previous|next)\s+(?:application|overview|news|search|winners?|representatives?)\b/i.test(clean) &&
    /\b(application overview|search|winners?|representatives?|districts?|brochure|frequently asked questions?)\b/i.test(clean) &&
    /\b(apply|back|search|toggle menu)\b/i.test(clean)
  );
}

function looksLikeOrphanPunctuation(value) {
  const clean = normalizeText(String(value || ""));
  return Boolean(clean) && (/^[\s:;,.!?|/\\()[\]{}'"-]+$/.test(clean) || /(?:^|\s)[|/\\]{2,}(?:\s|$)/.test(clean));
}

function cleanAiSummary(text, fallback, nextText = "", source = null) {
  const clean = normalizeText(String(text || "")).replace(/^[-*\s]+/, "");
  if (!clean) return fallback;
  if (isVagueSummary(clean)) return fallback;
  if (hasUnsupportedCurrentDateClaim(clean, nextText)) return fallback;
  if (source && isIrrelevantHomepageChange(source, clean)) return fallback;
  return clean.slice(0, 800);
}

function cleanWorkerSummaryForSource(source, summary) {
  if (isIrrelevantHomepageChange(source, summary)) {
    return "No award-relevant wording changed in the stored excerpt.";
  }

  return narrativeWorkerFallbackSummary(source, summary);
}

function narrativeWorkerFallbackSummary(source, summary) {
  const clean = normalizeText(String(summary || ""));
  const applicationOpen = clean.match(/^The application page now says applications are open:\s*(.+)$/i);
  if (applicationOpen) {
    return `The ${readableSourceTitle(source)} page now says applications are open: ${applicationOpen[1]}`;
  }

  const added = clean.match(/^Added text includes:\s*(.+)$/i);
  if (added) {
    const text = cleanDiffSummarySnippet(added[1]);
    if (text) return `The ${readableSourceTitle(source)} page added the following wording: ${text}`;
  }

  const removed = clean.match(/^Removed text includes:\s*(.+)$/i);
  if (removed) {
    const text = cleanDiffSummarySnippet(removed[1]);
    if (text) return `The ${readableSourceTitle(source)} page removed the following wording: ${text}`;
  }

  return clean;
}

function cleanDiffSummarySnippet(value) {
  const clean = normalizeText(value).replace(/\s*;\s*/g, " ");
  const quoted = [...clean.matchAll(/"([^"]+)"/g)]
    .map((match) => normalizeDiffSentence(match[1]))
    .filter(Boolean);
  if (quoted.length > 0) return quoted.join(" ");
  return normalizeDiffSentence(clean.replace(/^"+|"+\.$|"+$/g, ""));
}

function normalizeDiffSentence(value) {
  const clean = normalizeText(value).replace(/\.\.+$/g, ".");
  if (!clean) return "";
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function readableSourceTitle(source) {
  const title = normalizeText(source?.title || "");
  if (title && !/^(source page|homepage|other source)$/i.test(title)) return title;

  try {
    const parsed = new URL(source?.url || "");
    const segment = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (segment) {
      return segment
        .replace(/\.(html?|php|aspx?|pdf)$/i, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }
  } catch {
    // Keep the generic fallback below.
  }

  return "source";
}

function isVagueSummary(summary) {
  const normalized = summary.toLowerCase();
  return (
    summary.length < 28 ||
    looksLikeTruncatedSummaryFragment(summary) ||
    normalized.includes("added or expanded") ||
    normalized.includes("added text includes") ||
    normalized.includes("no award-relevant wording changed") ||
    normalized.startsWith("new date or deadline language appeared:") ||
    normalized.includes("application language") ||
    normalized.includes("page was updated") ||
    normalized.includes("page has been updated") ||
    normalized.includes("something changed") ||
    normalized.includes("content was updated")
  );
}

function looksLikeTruncatedSummaryFragment(summary) {
  const normalized = summary.toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);
  const lastWord = words.at(-1)?.replace(/[^a-z0-9]+/g, "") || "";
  const quoteCount = (summary.match(/"/g) || []).length;

  return (
    words.length < 6 ||
    (quoteCount % 2 === 1 && summary.length < 120) ||
    /^(the|on the|in the|from the)\s+"?[\w\s-]{0,40}$/.test(normalized) ||
    /^(the|on the|in the|from the)\s+[a-z]{1,8}$/.test(normalized) ||
    /^(a|an|the|and|or|of|on|to|for|from|with|in|by|through|into|about|over|under)$/.test(lastWord)
  );
}

function hasUnsupportedCurrentDateClaim(summary, nextText) {
  const nextDates = new Set(datePhrases(nextText).map((date) => date.toLowerCase()));
  if (!nextDates.size) return false;

  for (const { date, index } of datePhraseMatches(summary)) {
    const before = summary.slice(Math.max(0, index - 56), index).toLowerCase();
    const claimsCurrentValue =
      /\b(to|now|currently|is|are|updated to|changed to|moved to|deadline(?: is|:)?|submission deadline(?: is|:)?)\s*$/.test(
        before,
      );

    if (claimsCurrentValue && !nextDates.has(date.toLowerCase())) return true;
  }

  return false;
}

function datePhraseMatches(text) {
  const month =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const patterns = [
    new RegExp(`\\b(?:${month})\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?\\b`, "gi"),
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    /\b\d{4}-\d{2}-\d{2}\b/g,
  ];

  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => ({
      date: normalizeText(match[0]),
      index: match.index || 0,
    })),
  );
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text.trim();

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
      if (content.type === "text" && content.text) parts.push(content.text);
    }
  }

  return parts.join(" ").trim();
}

function extractGeminiText(data) {
  const parts = [];
  for (const candidate of data.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text === "string") parts.push(part.text);
    }
  }

  return parts.join(" ").trim();
}

function words(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);
}

function isUsefulWordAddition(word) {
  return !/^(required|statements|social|media|facebook|instagram|twitter|linkedin|youtube|subscribe|newsletter|copyright|privacy|menu|more|store|gift|amount|donate|donation|cart|checkout|publication|udallfoundation|parksinfocus|morris|suite|blvd|boulevard|street|avenue)$/.test(
    word,
  );
}

function datePhrases(text) {
  const month =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const patterns = [
    new RegExp(`\\b(?:${month})\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?\\b`, "gi"),
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    /\b\d{4}-\d{2}-\d{2}\b/g,
  ];
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => normalizeText(match[0])),
  );
}

function contextualMoneyPhrases(text) {
  return unique(
    [...text.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?\b/g)]
      .filter((match) => hasFundingAmountContext(contextAroundMatch(text, match.index || 0)))
      .map((match) => normalizeText(match[0])),
  );
}

function contextualDatePhrases(text) {
  return unique(sentenceCandidates(text).filter(isAwardDateContext).flatMap(datePhrases));
}

function contextAroundMatch(text, index) {
  return normalizeText(text.slice(Math.max(0, index - 180), index + 220));
}

function hasFundingAmountContext(value) {
  const lower = value.toLowerCase();
  if (/\b(cart|donate|donation|shop|store|subscribe|subscription|ticket|tickets|purchase|checkout|subtotal|merchandise|membership|sponsor|sponsorship)\b/.test(lower)) return false;
  return /\b(stipend|tuition|funding|funds?|grant|scholarships?|fellowships?|award amount|awards?:|amount awarded|prize|financial support|honorarium|living allowance|travel expenses?|research expenses?)\b/.test(lower);
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function isLikelySampleExpansion(previousText, nextText) {
  if (previousText.length < 500 || nextText.length <= previousText.length + 80) return false;
  if (nextText.startsWith(previousText)) return true;
  if (compactSentenceKey(nextText).startsWith(compactSentenceKey(previousText))) return true;
  if (!endsLikeTruncatedSample(previousText)) return false;

  for (const length of [180, 140, 100, 70]) {
    const tail = previousText.slice(-length).trim();
    if (tail.length < 60) continue;
    const index = nextText.indexOf(tail);
    if (index >= 0 && index + tail.length < nextText.length - 40) return true;
  }

  return false;
}

function endsLikeTruncatedSample(value) {
  const clean = normalizeText(value);
  if (!clean) return false;
  if (/[([{:/,-]\s*$/.test(clean)) return true;
  if (/[.!?)]['"]?$/.test(clean)) return false;
  const lastWord = clean.match(/[A-Za-z]+$/)?.[0] || "";
  return lastWord.length <= 3 || clean.length >= 1950;
}

function isNewsOrMarketingText(value) {
  return /\b(latest news|news|blog|story|stories|read more|published|press release|past recipients?|received the .* award|receives the .* award|photo by|getty images)\b/i.test(
    value,
  );
}

function isIrrelevantHomepageChange(source, summary) {
  if (!isRootHomepage(source?.url)) return false;
  const normalized = String(summary || "").toLowerCase();
  const awardName = source?.shared_awards?.name || source?.title || "";
  const awardType = awardProgramType(awardName);

  if (awardType === "scholarship" && /\binternship(s)?\b/.test(normalized)) return true;

  const tokens = meaningfulAwardTokens([awardName, source?.title].filter(Boolean).join(" "));
  if (tokens.some((token) => normalized.includes(token))) return false;

  return !/\b(application|apply|deadline|eligible|eligibility|requirement|recommendation|transcript|essay|interview|tuition|stipend|funding|fellowship|scholarship|award|admission|selection|nomination|candidate|submit|submission)\b/.test(
    normalized,
  );
}

function isRootHomepage(urlValue) {
  try {
    const url = new URL(urlValue);
    return url.pathname.replace(/\/+$/g, "") === "";
  } catch {
    return false;
  }
}

function awardProgramType(value) {
  const normalized = String(value || "").toLowerCase();
  if (/\bscholarship(s)?\b/.test(normalized)) return "scholarship";
  if (/\bfellowship(s)?\b/.test(normalized)) return "fellowship";
  if (/\binternship(s)?\b/.test(normalized)) return "internship";
  return "award";
}

function meaningfulAwardTokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 4 &&
        !/^(scholarship|scholarships|fellowship|fellowships|program|programs|award|awards|student|students|national|international|graduate|undergraduate|foundation|fund|trust|the|and|for|with|from)$/.test(
          token,
        ),
    );
}

function isBoilerplateOrNavigationText(value) {
  const lower = value.toLowerCase();
  return (
    /(cookie|privacy|copyright|all rights reserved|subscribe|newsletter|menu|skip to)/.test(lower) ||
    /(toggle page navigation|search menu|read current issue|cart|dismiss|login|donate|donation|shop|store|gift amount|support the publication|purchase|checkout)/.test(lower) ||
    /(social media|facebook|instagram|twitter|x\.com|linkedin|youtube|@[\w.-]+)/.test(lower) ||
    /(contact us|staff directory|site map|accessibility|required statements)/.test(lower) ||
    /\b(suite|blvd|boulevard|street|avenue)\b/.test(lower)
  );
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function contentTypeForPage(pageType, url) {
  if (pageType === "pdf" || new URL(url).pathname.toLowerCase().endsWith(".pdf")) return "pdf";
  return "auto";
}

function isInstitutionalDiscoveryUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return institutionalDiscoveryHosts.has(hostname);
  } catch {
    return false;
  }
}

function isTrackableOfficialSourceUrl(value) {
  return Boolean(value) && !isInstitutionalDiscoveryUrl(value) && !isClearlyNonAwardSourceUrl(value);
}

function normalizeSharedAwardKey(value) {
  const key = String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return canonicalSharedAwardKeyAlias(key) || key;
}

function canonicalSharedAwardKeyAlias(key) {
  if (
    key === "national science foundation graduate research fellowship" ||
    key === "national science foundation graduate research fellowship program" ||
    key === "nsf graduate research fellowship"
  ) {
    return "nsf graduate research fellowship program";
  }
  return null;
}

function isMonitorableSharedSource(source) {
  if (!source?.url || isInstitutionalDiscoveryUrl(source.url)) return false;
  if (isHardBlockedOfficialSourceUrl(source.url)) return false;
  return isProtectedOfficialSourcePageType(source.page_type) || !isClearlyNonAwardSourceUrl(source.url);
}

function isProtectedOfficialSourcePageType(value) {
  return protectedOfficialSourcePageTypes.has(String(value || "").toLowerCase());
}

function isHardBlockedOfficialSourceUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const fullUrl = url.toString();
    const lowerPath = url.pathname.toLowerCase();
    if (!["http:", "https:"].includes(url.protocol)) return true;
    if (cmsAdminHosts.has(hostname)) return true;
    if (phoneNumberPathSegment.test(decodeURIComponent(url.pathname))) return true;
    return (
      /\/(?:[^/]*sitemap[^/]*|site-map[^/]*)(?:\.(?:xml|pdf|html?))?$/i.test(lowerPath) ||
      /\/(wp-login\.php|login|signin|sign-in|cart|donate|privacy|terms|terms-of-use|terms-of-service|termsofuse|jobregister)\b/i.test(lowerPath) ||
      /\/(sign-up|signup|subscribe|newsletter)\b/i.test(lowerPath) ||
      /\/portal\/user\/u_login\.php/i.test(lowerPath) ||
      /[?&](share|replytocom|utm_|fbclid|gclid|redirect_to=)/i.test(fullUrl)
    );
  } catch {
    return true;
  }
}

function isClearlyNonAwardSourceUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const fullUrl = url.toString();
    const lowerPath = url.pathname.toLowerCase();
    const awardRelated = /(scholar|fellow|award|grant|program|apply|application|deadline|eligib)/i.test(fullUrl);
    if (!["http:", "https:"].includes(url.protocol)) return true;
    if (cmsAdminHosts.has(hostname)) return true;
    if (phoneNumberPathSegment.test(decodeURIComponent(url.pathname))) return true;
    return (
      /\/(?:[^/]*sitemap[^/]*|site-map[^/]*)(?:\.(?:xml|pdf|html?))?$/i.test(lowerPath) ||
      /\/(wp-login\.php|login|signin|sign-in|cart|donate|privacy|terms|terms-of-use|terms-of-service|termsofuse|jobregister)\b/i.test(lowerPath) ||
      /\/(sign-up|signup|subscribe|newsletter)\b/i.test(lowerPath) ||
      /\/portal\/user\/u_login\.php/i.test(lowerPath) ||
      (!awardRelated && /\/(news|events|calendar|tag|category)\b/i.test(lowerPath)) ||
      /[?&](share|replytocom|utm_|fbclid|gclid|redirect_to=)/i.test(fullUrl) ||
      /\.(jpg|jpeg|png|gif|webp|svg|zip|ics|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/i.test(url.pathname)
    );
  } catch {
    return true;
  }
}

function debugNonAwardSourceUrlChecks(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const fullUrl = url.toString();
    const lowerPath = url.pathname.toLowerCase();
    const awardRelated = /(scholar|fellow|award|grant|program|apply|application|deadline|eligib)/i.test(fullUrl);
    return {
      protocol: !["http:", "https:"].includes(url.protocol),
      cms: cmsAdminHosts.has(hostname),
      phone: phoneNumberPathSegment.test(decodeURIComponent(url.pathname)),
      hard: /\/(wp-login\.php|login|signin|sign-in|cart|donate|privacy|terms|terms-of-use|terms-of-service|termsofuse|jobregister)\b/i.test(lowerPath),
      signup: /\/(sign-up|signup|subscribe|newsletter)\b/i.test(lowerPath),
      portal: /\/portal\/user\/u_login\.php/i.test(lowerPath),
      listing: !awardRelated && /\/(news|events|calendar|tag|category)\b/i.test(lowerPath),
      tracking: /[?&](share|replytocom|utm_|fbclid|gclid|redirect_to=)/i.test(fullUrl),
      asset: /\.(jpg|jpeg|png|gif|webp|svg|zip|ics|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/i.test(url.pathname),
    };
  } catch (error) {
    return { parseError: describeError(error, "Unable to parse URL.") };
  }
}

function isLikelyOfficialExternalLink(url, title, baseUrl) {
  const normalizedHost = url.hostname.toLowerCase().replace(/^www\./, "");
  const baseHost = baseUrl.hostname.toLowerCase().replace(/^www\./, "");
  if (normalizedHost === baseHost) return !isInstitutionalDiscoveryUrl(baseUrl.toString());
  if (isInstitutionalDiscoveryUrl(url.toString())) return false;
  if (["asu.edu", "illinois.edu"].includes(registrableDomain(normalizedHost))) return false;
  if (nonOfficialExternalHosts.has(registrableDomain(normalizedHost))) return false;

  const lower = `${title} ${url.toString()}`.toLowerCase();
  if (/\b(map|locations?|jobs|jobregister|directory|contact|privacy|terms|termsofuse|accessibility|emergency|wp-login)\b/.test(lower)) {
    return false;
  }

  return (
    title.trim().length > 0 ||
    /scholar|fellow|award|program|apply|application/.test(lower)
  );
}

function isExcludedUrl(url) {
  const lower = url.toString().toLowerCase();
  const awardRelated = /(scholar|fellow|award|grant|program|apply|application|deadline|eligib)/.test(lower);
  return (
    /\/(wp-login\.php|login|signin|sign-in|register|cart|donate|privacy|terms|terms-of-use|terms-of-service|termsofuse|jobregister)\b/.test(lower) ||
    /\/(sign-up|signup|subscribe|newsletter)\b/.test(lower) ||
    /\/portal\/user\/u_login\.php/.test(lower) ||
    (!awardRelated && /\/(news|events|calendar|tag|category)\b/.test(lower)) ||
    /[?&](share|replytocom|utm_|fbclid|gclid|redirect_to=)/.test(lower) ||
    /\.(jpg|jpeg|png|gif|webp|svg|zip|ics|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/i.test(url.pathname)
  );
}

async function assertPublicHttpUrl(input) {
  const url = new URL(input.trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs can be monitored.");
  }
  if (!url.hostname || ["localhost", "0.0.0.0", "::1"].includes(url.hostname.toLowerCase())) {
    throw new Error("This host cannot be monitored.");
  }
  if (isPrivateIp(url.hostname)) {
    throw new Error("Private network URLs cannot be monitored.");
  }

  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.some((address) => isPrivateIp(address.address))) {
    throw new Error("This URL resolves to a private network address.");
  }

  return url;
}

function isPrivateIp(value) {
  const version = net.isIP(value);
  if (!version) return false;
  if (version === 4) {
    const [a, b] = value.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  const lower = value.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

function nextCheckDate(minutes = checkIntervalMinutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function nextStructureScanDate() {
  return new Date(Date.now() + structureRescanDays * 24 * 60 * 60 * 1000).toISOString();
}

function structureScanDue(sharedAward) {
  if (!sharedAward?.next_structure_scan_at) return true;
  return new Date(sharedAward.next_structure_scan_at).getTime() <= Date.now();
}

async function markStructureScan(sharedAwardId, error) {
  await supabase
    .from("shared_awards")
    .update({
      last_structure_scan_at: new Date().toISOString(),
      next_structure_scan_at: nextStructureScanDate(),
      structure_scan_error: error ? error.slice(0, 500) : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sharedAwardId);
}

function normalizeUrlKey(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const pathname = parsed.pathname
    .replace(/\/index\.(html?|php|aspx?)$/i, "/")
    .replace(/\.aspx$/i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();

  return `${hostname}${pathname || "/"}${parsed.search.toLowerCase()}`;
}

function changeSummaryDedupeKey(change) {
  const details = change.change_details || change.changeDetails || null;
  const evidenceKey = changeEvidenceDedupeKey(details);
  if (evidenceKey && change.shared_award_id) {
    return `award:${change.shared_award_id}|${evidenceKey}`;
  }

  const normalizedSummary = normalizeSummaryForDedupe(change.summary);
  if (!normalizedSummary) return "";

  const normalizedUrl = normalizeSourceUrlForSummaryDedupe(change.source_url);
  if (normalizedUrl) return `url:${normalizedUrl}|summary:${normalizedSummary}`;

  return `award:${change.shared_award_id || ""}|summary:${normalizedSummary}`;
}

function changeEvidenceDedupeKey(changeDetails) {
  if (!changeDetails || changeDetails.is_alert_worthy === false) return "";
  const diff = changeDetails.structured_diff || {};
  const evidenceParts = [
    changeDetails.before,
    changeDetails.after,
    ...(diff.added_text || []),
    ...(diff.removed_text || []),
    ...(diff.date_changes || []),
    ...(diff.amount_changes || []),
  ]
    .map(normalizeEvidenceForDedupe)
    .filter(Boolean);

  if (evidenceParts.length < 2) return "";
  return `evidence:${evidenceParts.join("|")}`;
}

function normalizeSourceUrlForSummaryDedupe(value) {
  const clean = String(value || "").trim();
  if (!clean) return "";

  try {
    const parsed = new URL(clean);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname
      .replace(/\/index\.(html?|php|aspx?)$/i, "/")
      .replace(/\.aspx$/i, "")
      .replace(/\/+$/g, "")
      .toLowerCase();

    return `${hostname}${pathname || "/"}`;
  } catch {
    return clean
      .toLowerCase()
      .replace(/[?#].*$/, "")
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "");
  }
}

function normalizeSummaryForDedupe(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeEvidenceForDedupe(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\.\.\.$/, "")
    .replace(/[.,;:\s]+$/g, "");
}

function tokens(value) {
  return value.toLowerCase().match(/[a-z0-9]+/g) || [];
}

function directoryPath(pathname) {
  const lower = pathname.toLowerCase();
  const index = lower.lastIndexOf("/");
  if (index <= 0) return "/";
  return lower.slice(0, index + 1);
}

function isRelatedHost(hostname, baseHostname) {
  const normalizedHost = hostname.toLowerCase().replace(/^www\./, "");
  const normalizedBase = baseHostname.toLowerCase().replace(/^www\./, "");
  if (isSeparateProgramHost(normalizedHost, normalizedBase)) return false;

  const baseDomain = registrableDomain(normalizedBase);
  return (
    normalizedHost === normalizedBase ||
    normalizedHost === baseDomain ||
    normalizedHost.endsWith(`.${baseDomain}`)
  );
}

function isSeparateProgramHost(hostname, baseHostname) {
  if (hostname === baseHostname) return false;
  return separateProgramHostGroups.some(
    (group) => group.has(hostname) && group.has(baseHostname),
  );
}

function registrableDomain(hostname) {
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

function escapeLike(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
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

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function hoursToMinutes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number * 60) : undefined;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function selectAiProvider(requestedProvider, keys) {
  const requested = String(requestedProvider || "auto").toLowerCase();
  if (requested === "false" || requested === "none") return null;
  if (requested === "gemini") return keys.gemini ? "gemini" : null;
  if (requested === "openai") return keys.openai ? "openai" : null;
  if (keys.gemini) return "gemini";
  if (keys.openai) return "openai";
  return null;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
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
