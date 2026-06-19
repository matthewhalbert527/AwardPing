#!/usr/bin/env node
import dns from "node:dns/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import * as cheerio from "cheerio";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";
import { buildConciseReadableSummary, stripRawChangeLead } from "./lib/update-squash-summary.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = { ...loadEnvFile(envPath), ...process.env };
const apply = args.apply === true || args.apply === "true";
const targetCount = readLimit(args.limit || args.updates, 20);
const scanLimit = positiveInt(
  args["scan-limit"],
  targetCount === Number.POSITIVE_INFINITY ? 6000 : Math.max(160, targetCount * 8),
);
const checkLive = args["check-live"] !== "false";
const aiArg = args.ai === undefined ? "auto" : String(args.ai);
const fetchTimeoutMs = positiveInt(args["fetch-timeout-ms"], 22_000);
const maxSourceBytes = positiveInt(args["max-source-bytes"], 18 * 1024 * 1024);
const domainDelayMs = nonNegativeInt(args["domain-delay-ms"], 500);
const retryCount = positiveInt(args.retries, 3);
const retryDelayMs = positiveInt(args["retry-delay-ms"], 850);
const progressEvery = nonNegativeInt(
  args["progress-every"],
  targetCount === Number.POSITIVE_INFINITY ? 50 : 0,
);
const outputPath =
  args.output ||
  join(
    root,
    "reports",
    "update-bug-squash-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json",
  );

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createSupabaseServiceClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
);
const hostLastFetchAt = new Map();
let selectionStats = null;
const crawlerUserAgent =
  "Mozilla/5.0 (compatible; AwardPingUpdateBugSquasher/1.0; +https://awardping.com/contact)";
const fallbackUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AwardPingUpdateBugSquasher/1.0 Chrome/124.0 Safari/537.36 (+https://awardping.com/contact)";
const institutionalDiscoveryHosts = new Set([
  "fellowship-finder.grad.illinois.edu",
  "onsa.asu.edu",
]);
const cmsAdminHosts = new Set(["a.cms.omniupdate.com"]);
const hardNonAwardPath =
  /\/(wp-login\.php|login|signin|sign-in|cart|donate|privacy|terms|terms-of-use|terms-of-service|termsofuse|jobregister)\b|\/(sign-up|signup|subscribe|newsletter)\b|\/portal\/user\/u_login\.php/i;
const listingPath = /\/(news|events|calendar|tag|category)\b/i;
const trackingQuery = /[?&](share|replytocom|utm_|fbclid|gclid|redirect_to=)/i;
const nonMonitorableAsset = /\.(jpg|jpeg|png|gif|webp|svg|zip|ics|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/i;
const awardRelatedText = /(scholar|fellow|award|grant|program|apply|application|deadline|eligib)/i;
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
const hardQualityFlags = new Set([
  "ai_invalid_json",
  "source_access_error",
  "raw_scrape_signal",
  "orphan_punctuation",
  "vague_summary",
  "no_actual_changed_fact",
  "sample_expansion",
  "unsupported_structured_fact",
  "indistinct_truncated_snippet",
  "format_only_change",
  "context_only_change",
]);

console.log(
  "Squashing update bugs; apply=" +
    apply +
    "; updates=" +
    targetCount +
    "; scanLimit=" +
    scanLimit +
    "; live=" +
    checkLive +
    ".",
);

const firstPass = await loadVisibleSharedUpdates();
const regenerationTargets = firstPass
  .filter((update) => shouldRegenerateStructuredDetails(update))
  .map((update) => update.id);

let backfillResult = null;
if (regenerationTargets.length > 0) {
  backfillResult = await maybeRunBackfill(regenerationTargets);
}

const updates = backfillResult?.applied ? await reloadUpdates(firstPass) : firstPass;
const results = [];
const stats = {
  scanned: scanLimit,
  selected: updates.length,
  selection: selectionStats,
  needsBackfill: regenerationTargets.length,
  backfillApplied: Boolean(backfillResult?.applied),
  checkedLive: 0,
  liveFetchFailed: 0,
  wouldReject: 0,
  rejected: 0,
  wouldUpdateSummary: 0,
  updatedSummary: 0,
  manualReview: 0,
  kept: 0,
};

let auditedCount = 0;
for (const update of updates) {
  const result = await auditUpdate(update);
  auditedCount += 1;
  results.push(result);
  if (result.live?.status === "checked") stats.checkedLive += 1;
  if (result.live?.status === "fetch_failed") stats.liveFetchFailed += 1;

  if (result.action?.type === "reject") {
    if (apply) {
      await rejectUpdate(update, result.action.reason, result.action.flags);
      result.action.applied = true;
      stats.rejected += 1;
    } else {
      stats.wouldReject += 1;
    }
    maybeLogAuditProgress(auditedCount, updates.length, stats);
    continue;
  }

  if (result.action?.type === "update_summary") {
    if (apply) {
      await updateSummary(update, result.action.summary);
      result.action.applied = true;
      stats.updatedSummary += 1;
    } else {
      stats.wouldUpdateSummary += 1;
    }
    maybeLogAuditProgress(auditedCount, updates.length, stats);
    continue;
  }

  if (result.action?.type === "manual_review") {
    stats.manualReview += 1;
    maybeLogAuditProgress(auditedCount, updates.length, stats);
    continue;
  }

  stats.kept += 1;
  maybeLogAuditProgress(auditedCount, updates.length, stats);
}

mkdirSync(resolve(outputPath, ".."), { recursive: true });
writeFileSync(
  outputPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      apply,
      args,
      stats,
      backfill: backfillResult,
      results,
    },
    null,
    2,
  ),
);

console.log("Wrote " + outputPath);
console.log(JSON.stringify(stats, null, 2));

async function loadVisibleSharedUpdates() {
  const changeRows = await loadSharedChangeRows();
  const awardNameById = await loadAwardNames(changeRows.map((change) => change.shared_award_id));
  const monitorableRows = changeRows.filter((change) =>
    isMonitorableOfficialSource({
      url: change.source_url,
      page_type: change.source_page_type,
    }),
  );
  const usefulRows = monitorableRows.filter((change) => {
      const awardName = awardNameById.get(change.shared_award_id) || null;
      return isUsefulChangeForAward({
          summary: change.summary,
          change_details: change.change_details,
          awardName,
          sourceTitle: change.source_title,
          sourceUrl: change.source_url,
        });
    });
  const dedupedRows = dedupeChangeSummaries(usefulRows);
  selectionStats = {
    rawRows: changeRows.length,
    monitorableRows: monitorableRows.length,
    usefulRows: usefulRows.length,
    dedupedRows: dedupedRows.length,
  };
  if (args["debug-selection"] === "true") {
    console.log("Selection " + JSON.stringify(selectionStats));
    console.log(
      "Selection debug " +
        JSON.stringify(
          changeRows.slice(0, 5).map((change) => ({
            id: change.id,
            pageType: change.source_page_type,
            url: change.source_url,
            institutional: isInstitutionalDiscoveryUrl(change.source_url),
            hardBlocked: isHardBlockedOfficialSourceUrl(change.source_url),
            protectedType: isProtectedOfficialSourcePageType(change.source_page_type),
            clearlyNonAward: isClearlyNonAwardSourceUrl(change.source_url),
            monitorable: isMonitorableOfficialSource({
              url: change.source_url,
              page_type: change.source_page_type,
            }),
          })),
        ),
    );
  }
  const visible = dedupedRows.slice(0, targetCount);

  const snapshotById = await loadSnapshots(visible);
  return visible.map((change) => toUpdate(change, awardNameById, snapshotById));
}

async function loadSharedChangeRows() {
  const rows = [];
  const pageSize = 1000;

  for (let from = 0; rows.length < scanLimit; from += pageSize) {
    const to = Math.min(from + pageSize - 1, scanLimit - 1);
    const data = await withRetry("load shared update rows " + from, async () => {
      const { data, error } = await supabase
        .from("shared_award_change_events")
        .select(
          "id, shared_award_id, shared_award_source_id, source_title, source_url, source_page_type, previous_snapshot_id, new_snapshot_id, summary, change_details, detected_at",
        )
        .order("detected_at", { ascending: false })
        .range(from, to);
      if (error) throw error;
      return data || [];
    });

    if (!data.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }

  return rows.slice(0, scanLimit);
}

async function reloadUpdates(previousUpdates) {
  const ids = previousUpdates.map((update) => update.id);
  if (!ids.length) return [];

  const changes = await loadInChunks(
    "shared_award_change_events",
    "id, shared_award_id, shared_award_source_id, source_title, source_url, source_page_type, previous_snapshot_id, new_snapshot_id, summary, change_details, detected_at",
    ids,
  );
  const orderById = new Map(ids.map((id, index) => [id, index]));
  const changeRows = (changes || []).sort(
    (left, right) => (orderById.get(left.id) || 0) - (orderById.get(right.id) || 0),
  );
  const awardNameById = await loadAwardNames(changeRows.map((change) => change.shared_award_id));
  const snapshotById = await loadSnapshots(changeRows);
  return changeRows.map((change) => toUpdate(change, awardNameById, snapshotById));
}

function toUpdate(change, awardNameById, snapshotById) {
  const details = parseChangeDetails(change.change_details);
  const displaySummary = displayChangeSummary(
    change.summary,
    change.source_url,
    change.change_details,
  );

  return {
    id: change.id,
    kind: "shared",
    awardId: change.shared_award_id,
    awardName: awardNameById.get(change.shared_award_id) || "Shared award",
    sourceTitle: change.source_title || "Source page",
    sourceUrl: change.source_url,
    sourcePageType: change.source_page_type,
    previousSnapshotId: change.previous_snapshot_id,
    newSnapshotId: change.new_snapshot_id,
    previousTextSample: change.previous_snapshot_id
      ? snapshotById.get(change.previous_snapshot_id) || ""
      : "",
    newTextSample: change.new_snapshot_id ? snapshotById.get(change.new_snapshot_id) || "" : "",
    summary: change.summary || "",
    displaySummary,
    changeDetails: change.change_details || {},
    details,
    detectedAt: change.detected_at,
  };
}

async function loadAwardNames(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return new Map();

  const rows = await loadInChunks("shared_awards", "id, name", uniqueIds);
  return new Map(rows.map((award) => [award.id, award.name]));
}

async function loadSnapshots(changes) {
  const ids = [
    ...new Set(
      changes
        .flatMap((change) => [change.previous_snapshot_id, change.new_snapshot_id])
        .filter(Boolean),
    ),
  ];
  if (!ids.length) return new Map();

  const rows = await loadInChunks("shared_award_source_snapshots", "id, text_sample", ids);
  return new Map(rows.map((snapshot) => [snapshot.id, snapshot.text_sample || ""]));
}

async function loadInChunks(table, columns, ids) {
  const rows = [];
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const data = await withRetry("load " + table + " chunk " + index, async () => {
      const { data, error } = await supabase.from(table).select(columns).in("id", chunk);
      if (error) throw error;
      return data || [];
    });
    rows.push(...data);
  }
  return rows;
}

function shouldRegenerateStructuredDetails(update) {
  const details = update.details;
  if (!update.previousTextSample || !update.newTextSample) return false;
  if (!details) return true;
  if (!details.reader_summary) return true;
  const unclear = looksUnclearPlainEnglish(update.displaySummary);
  if (details.reader_summary !== update.summary && unclear) return true;
  if (unclear) {
    return !["gemini", "openai"].includes(details.generation_provider);
  }
  if (details.quality_flags.some((flag) => hardQualityFlags.has(flag))) return true;
  if (details.generation_status === "fallback" && details.generation_provider !== "heuristic") {
    return true;
  }
  return false;
}

async function maybeRunBackfill(ids) {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return null;

  const idsPath = join(
    root,
    "tmp",
    "update-bug-squash-ids-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt",
  );
  writeFileSync(idsPath, uniqueIds.join("\n") + "\n");

  const backfillArgs = [
    "scripts/backfill-change-details.mjs",
    "--apply=" + (apply ? "true" : "false"),
    "--force=true",
    "--ids-file=" + relative(root, idsPath),
    "--env=" + relative(root, envPath),
    "--output=" +
      relative(
        root,
        join(
          root,
          "reports",
          "update-bug-squash-backfill-" +
            new Date().toISOString().replace(/[:.]/g, "-") +
            ".json",
        ),
      ),
  ];
  if (aiArg === "false") backfillArgs.push("--ai=false");
  if (aiArg === "gemini" || aiArg === "openai") backfillArgs.push("--ai-provider=" + aiArg);

  if (!apply) {
    return {
      applied: false,
      ids: uniqueIds,
      idsFile: idsPath,
      command: ["node", ...backfillArgs].join(" "),
      reason: "Run with --apply=true to regenerate weak summaries.",
    };
  }

  const result = spawnSync(process.execPath, backfillArgs, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("Backfill failed for update bug squasher targets.");
  }

  return {
    applied: true,
    ids: uniqueIds,
    idsFile: idsPath,
    command: ["node", ...backfillArgs].join(" "),
  };
}

async function auditUpdate(update) {
  const issues = [];
  const quality = updateQualityIssues(update);
  issues.push(...quality);
  let live = null;

  if (checkLive) {
    live = await auditLiveVisibility(update);
    if (live.issue) issues.push(live.issue);
  }

  const rejectIssue = issues.find((issue) => issue.action === "reject");
  if (rejectIssue) {
    return {
      ...resultBase(update),
      issues,
      live,
      action: {
        type: "reject",
        reason: rejectIssue.message,
        flags: rejectIssue.flags,
        applied: false,
      },
    };
  }

  const summaryFix = betterStoredSummary(update);
  if (summaryFix && update.displaySummary !== summaryFix) {
    return {
      ...resultBase(update),
      issues,
      live,
      action: {
        type: "update_summary",
        summary: summaryFix,
        applied: false,
      },
    };
  }

  return {
    ...resultBase(update),
    issues,
    live,
    action: issues.some((issue) => issue.action === "manual_review")
      ? { type: "manual_review" }
      : { type: "keep" },
  };
}

function resultBase(update) {
  return {
    id: update.id,
    awardName: update.awardName,
    sourceTitle: update.sourceTitle,
    sourceUrl: update.sourceUrl,
    sourcePageType: update.sourcePageType,
    detectedAt: update.detectedAt,
    summary: update.displaySummary,
    currentAlertWorthy: update.details?.is_alert_worthy ?? null,
    currentFlags: update.details?.quality_flags || [],
  };
}

function updateQualityIssues(update) {
  const issues = [];
  const details = update.details;
  const summary = update.displaySummary;

  if (!details) {
    issues.push({
      code: "missing_structured_details",
      message: "The update does not have structured change details.",
      action: update.previousTextSample && update.newTextSample ? "manual_review" : "reject",
      flags: ["missing_structured_details"],
    });
  } else if (details.is_alert_worthy === false) {
    issues.push({
      code: "not_alert_worthy",
      message: "The stored structured details already mark this as not alert-worthy.",
      action: "reject",
      flags: ["not_alert_worthy"],
    });
  }

  const flags = new Set([
    ...(details?.quality_flags || []),
    ...(details?.structured_diff?.noise_flags || []),
  ]);
  if (
    looksLikeSourceAccessError(update.previousTextSample) ||
    looksLikeSourceAccessError(update.newTextSample)
  ) {
    issues.push({
      code: "source_access_error",
      message: "The stored comparison includes an error or access-denied snapshot, so it is not a reliable content update.",
      action: "reject",
      flags: ["source_access_error"],
    });
  }
  if (flags.has("profile_testimonial_change")) {
    issues.push({
      code: "profile_or_roster_churn",
      message: "The update only describes profile, testimonial, fellow, recipient, or roster churn.",
      action: "reject",
      flags: ["profile_testimonial_change", "low_value_public_update"],
    });
  }
  if (flags.has("ai_rejected") || details?.generation_status === "rejected") {
    issues.push({
      code: "ai_rejected_summary",
      message: "The AI summary pass rejected this update, so it should not stay public as alert-worthy.",
      action: "reject",
      flags: ["ai_rejected"],
    });
  }

  const hardFlags = [...flags].filter((flag) => hardQualityFlags.has(flag));
  if (hardFlags.length > 0) {
    issues.push({
      code: "hard_quality_flags",
      message: "The update has hard quality flags: " + hardFlags.join(", ") + ".",
      action: "reject",
      flags: hardFlags,
    });
  }

  if (looksLowValueUpdate(update, summary)) {
    issues.push({
      code: "low_value_public_update",
      message: "The update looks like news, profile, event, navigation, or marketing churn rather than an actionable award change.",
      action: "reject",
      flags: ["low_value_public_update"],
    });
  }

  if (looksUnclearPlainEnglish(summary)) {
    const unclearShouldReject =
      /https?:\/\//i.test(summary) ||
      /^The\s+.+\s+page\s+changed\s+wording\s+from\b/i.test(summary);
    issues.push({
      code: "unclear_plain_english",
      message: "The update summary is not clear plain English.",
      action:
        update.previousTextSample && update.newTextSample && !unclearShouldReject
          ? "manual_review"
          : "reject",
      flags: ["unclear_plain_english"],
    });
  }

  return issues;
}

function betterStoredSummary(update) {
  const concise = conciseReadableSummary(update);
  if (concise && update.displaySummary !== concise) return concise;

  const detailsSummary = cleanDisplayText(update.details?.reader_summary || "");
  if (!detailsSummary || looksUnclearPlainEnglish(detailsSummary)) return "";
  if (!looksUnclearPlainEnglish(update.displaySummary) && update.summary === detailsSummary) return "";
  return detailsSummary;
}

function conciseReadableSummary(update) {
  return buildConciseReadableSummary(update.displaySummary);
}

async function auditLiveVisibility(update) {
  const expectations = visibilityExpectations(update);
  if (!expectations.length) {
    return {
      status: "not_checkable",
      issue: {
        code: "no_live_visibility_claim",
        message: "No concrete added/removed snippet was available for live-page verification.",
        action: "manual_review",
        flags: ["no_live_visibility_claim"],
      },
    };
  }

  let liveText = "";
  try {
    liveText = await fetchSourceText(update.sourceUrl, update.sourcePageType);
  } catch (error) {
    return {
      status: "fetch_failed",
      error: errorMessage(error),
      issue: {
        code: "live_fetch_failed",
        message: "Could not fetch the live source page to verify this update.",
        action: "manual_review",
        flags: ["live_fetch_failed"],
      },
    };
  }

  const failed = [];
  const passed = [];
  for (const expectation of expectations) {
    const present = containsLooseSnippet(liveText, expectation.text);
    const ok = expectation.mode === "present" ? present : !present;
    if (ok) passed.push(expectation);
    else failed.push({ ...expectation, present });
  }

  if (failed.length > 0) {
    return {
      status: "checked",
      passed,
      failed,
      issue: {
        code: "live_source_mismatch",
        message: "The live source page did not support the stored change claim.",
        action: "reject",
        flags: ["live_source_mismatch"],
      },
    };
  }

  return { status: "checked", passed, failed: [] };
}

function visibilityExpectations(update) {
  const details = update.details;
  if (!details || details.is_alert_worthy === false) return [];

  const expectations = [];
  const afterSnippets = unique([
    details.after,
    ...(details.structured_diff?.added_text || []),
  ].filter(Boolean));
  const beforeSnippets = unique([
    details.before,
    ...(details.structured_diff?.removed_text || []),
  ].filter(Boolean));

  for (const snippet of afterSnippets) {
    if (isCheckableSnippet(snippet)) {
      expectations.push({ mode: "present", text: snippet, source: "added_or_after" });
    }
  }

  if (!afterSnippets.length) {
    for (const change of details.structured_diff?.date_changes || []) {
      const text = change.replace(/^Added\s+/i, "").trim();
      if (change.startsWith("Added ") && isCheckableSnippet(text)) {
        expectations.push({ mode: "present", text, source: "added_date" });
      }
      if (change.startsWith("Removed ") && isCheckableSnippet(text)) {
        expectations.push({ mode: "absent", text, source: "removed_date" });
      }
    }
    for (const change of details.structured_diff?.amount_changes || []) {
      const text = change.replace(/^Added\s+/i, "").replace(/^Removed\s+/i, "").trim();
      if (change.startsWith("Added ") && isCheckableSnippet(text)) {
        expectations.push({ mode: "present", text, source: "added_amount" });
      }
      if (change.startsWith("Removed ") && isCheckableSnippet(text)) {
        expectations.push({ mode: "absent", text, source: "removed_amount" });
      }
    }
  }

  if (!afterSnippets.length) {
    for (const snippet of beforeSnippets) {
      if (isCheckableSnippet(snippet)) {
        expectations.push({ mode: "absent", text: snippet, source: "removed_or_before" });
      }
    }
  }

  return dedupeExpectations(expectations).slice(0, 4);
}

function isCheckableSnippet(value) {
  const clean = cleanDisplayText(value);
  if (clean.length < 8) return false;
  if (hasRawScrapeSignals(clean)) return false;
  if (/^[\s:;,.!?|/\\()[\]{}'"-]+$/.test(clean)) return false;
  return true;
}

function dedupeExpectations(expectations) {
  const seen = new Set();
  const result = [];
  for (const expectation of expectations) {
    const key = expectation.mode + ":" + normalizeContainmentText(expectation.text).slice(0, 140);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(expectation);
  }
  return result;
}

async function rejectUpdate(update, reason, flags) {
  const details = buildRejectedDetails(update, reason, flags);
  const { error } = await supabase
    .from("shared_award_change_events")
    .update({
      summary: details.reader_summary,
      change_details: details,
    })
    .eq("id", update.id);
  if (error) throw error;
}

async function updateSummary(update, summary) {
  const details = update.details
    ? {
        ...update.details,
        reader_summary: summary,
        generated_at: new Date().toISOString(),
      }
    : update.changeDetails;

  const { error } = await supabase
    .from("shared_award_change_events")
    .update({
      summary,
      change_details: details,
    })
    .eq("id", update.id);
  if (error) throw error;
}

function buildRejectedDetails(update, reason, flags) {
  const existing = update.details;
  const structuredDiff = existing?.structured_diff || {
    added_text: [],
    removed_text: [],
    likely_section: update.sourceTitle || null,
    page_type: update.sourcePageType || null,
    date_changes: [],
    amount_changes: [],
    noise_flags: [],
  };

  return {
    reader_summary: "No award-relevant wording changed in the stored excerpt.",
    before: null,
    after: null,
    section: existing?.section || structuredDiff.likely_section || update.sourceTitle || null,
    change_type: "noise",
    advisor_impact: null,
    is_alert_worthy: false,
    confidence: "low",
    structured_diff: {
      added_text: structuredDiff.added_text || [],
      removed_text: structuredDiff.removed_text || [],
      likely_section: structuredDiff.likely_section || update.sourceTitle || null,
      page_type: structuredDiff.page_type || update.sourcePageType || null,
      date_changes: structuredDiff.date_changes || [],
      amount_changes: structuredDiff.amount_changes || [],
      noise_flags: unique([...(structuredDiff.noise_flags || []), ...flags]),
    },
    source: {
      award_name: update.awardName || null,
      source_title: update.sourceTitle || null,
      source_url: update.sourceUrl || null,
      page_type: update.sourcePageType || null,
    },
    quality_flags: unique([...(existing?.quality_flags || []), ...flags]),
    generated_at: new Date().toISOString(),
    generation_provider: existing?.generation_provider || "heuristic",
    generation_status: "rejected",
    generation_model: existing?.generation_model || null,
    rejection_reason: reason,
  };
}

async function fetchSourceText(rawUrl, pageType) {
  const safeUrl = await assertPublicHttpUrl(rawUrl);
  await waitForCrawlerHost(safeUrl);
  const response = await fetchCrawlerResponse(safeUrl);

  if (!response.ok) throw new Error("Fetch failed with HTTP " + response.status + ".");

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxSourceBytes) throw new Error("Source is too large for the live check.");

  const contentType = response.headers.get("content-type") || "";
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxSourceBytes) {
    throw new Error("Source is too large for the live check.");
  }

  const isPdf =
    pageType === "pdf" ||
    contentType.includes("application/pdf") ||
    safeUrl.pathname.toLowerCase().endsWith(".pdf");
  const rawText = isPdf
    ? await extractPdfText(arrayBuffer)
    : extractHtmlText(Buffer.from(arrayBuffer).toString("utf8"));
  const text = cleanDisplayText(rawText);
  if (!text) throw new Error("No readable text was found on this URL.");
  return text;
}

async function fetchCrawlerResponse(url) {
  const attempts = [crawlerHeaders(crawlerUserAgent), crawlerHeaders(fallbackUserAgent)];
  let latestResponse = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const response = await fetch(url, {
      redirect: "follow",
      headers: attempts[index],
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
    if (response.ok) return response;
    latestResponse = response;

    if (index === attempts.length - 1 || !shouldRetryWithAlternateHeaders(response.status)) {
      return response;
    }

    await response.body?.cancel().catch(() => undefined);
    await sleep(retryDelayMs);
  }

  return latestResponse;
}

function crawlerHeaders(userAgent) {
  return {
    "user-agent": userAgent,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,text/plain;q=0.7,*/*;q=0.5",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer: "https://awardping.com/",
  };
}

function shouldRetryWithAlternateHeaders(status) {
  return status === 403 || status === 405 || status === 429 || status >= 500;
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

async function assertPublicHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid source URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP(S) source URLs can be checked.");
  }
  if (isPrivateIp(url.hostname)) {
    throw new Error("Private network URLs cannot be checked.");
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
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    );
  }
  const lower = value.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

function containsLooseSnippet(text, snippet) {
  const haystack = normalizeContainmentText(text);
  const needle = normalizeContainmentText(snippet);
  if (!haystack || !needle) return false;
  if (haystack.includes(needle)) return true;

  const compactHaystack = compactContainmentText(text);
  const compactNeedle = compactContainmentText(snippet);
  if (compactNeedle.length >= 30 && compactHaystack.includes(compactNeedle)) return true;

  const words = needle.split(" ").filter((word) => word.length > 2);
  if (words.length < 5) return false;

  for (let size = Math.min(12, words.length); size >= 5; size -= 1) {
    for (let index = 0; index + size <= words.length; index += 1) {
      const phrase = words.slice(index, index + size).join(" ");
      if (phrase.length >= 32 && haystack.includes(phrase)) return true;
    }
  }

  return false;
}

function normalizeContainmentText(value) {
  return cleanDisplayText(value)
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^a-z0-9$%.,:;'"()\-/\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactContainmentText(value) {
  return normalizeContainmentText(value).replace(/[^a-z0-9]+/g, "");
}

function isUsefulChangeForAward(change) {
  if (!isUsefulChangeSummary(change.summary, change.change_details)) return false;

  const summary = displayChangeSummary(change.summary, change.sourceUrl, change.change_details);
  return isRelevantToAward(summary, change.awardName, change.sourceTitle, change.sourceUrl);
}

function isUsefulChangeSummary(summary, changeDetails) {
  const meaningfulDetails = isMeaningfulChangeDetails(changeDetails);
  if (meaningfulDetails === false) return false;

  const clean = cleanDisplayText(changeDetailsToSummary(changeDetails, summary));
  const normalized = clean.toLowerCase();
  if (!normalized) return false;

  return (
    clean.length >= 28 &&
    !looksLikeTruncatedFragment(clean) &&
    !normalized.startsWith("new terms found:") &&
    !normalized.includes("no award-relevant wording changed") &&
    !normalized.startsWith("new date or deadline language appeared:") &&
    !normalized.startsWith("initial award page snapshot captured") &&
    !normalized.includes("no concise word-level summary") &&
    !normalized.includes("no meaningful change") &&
    !normalized.includes("added or expanded") &&
    !normalized.includes("application language") &&
    !normalized.includes("page was updated") &&
    !normalized.includes("page has been updated") &&
    !normalized.includes("something changed") &&
    !normalized.includes("content was updated") &&
    !normalized.includes("page text updated") &&
    !looksLikeBoilerplateChange(clean)
  );
}

function displayChangeSummary(summary, sourceUrl, changeDetails) {
  return rewritePathSourceLabel(cleanDisplayText(changeDetailsToSummary(changeDetails, summary)), sourceUrl);
}

function changeDetailsToSummary(changeDetails, fallbackSummary) {
  const details = parseChangeDetails(changeDetails);
  const summary = cleanShortText(details?.reader_summary);
  return summary || cleanShortText(fallbackSummary);
}

function isMeaningfulChangeDetails(changeDetails) {
  const details = parseChangeDetails(changeDetails);
  if (!details) return null;
  if (!details.is_alert_worthy) return false;
  return ![
    ...details.quality_flags,
    ...(details.structured_diff?.noise_flags || []),
  ].some((flag) => hardQualityFlags.has(flag));
}

function parseChangeDetails(value) {
  const parsed = objectValue(value) || parseJsonObject(value);
  if (!parsed) return null;
  const readerSummary = cleanShortText(parsed.reader_summary);
  if (!readerSummary) return null;

  return {
    reader_summary: readerSummary,
    before: nullableCleanText(parsed.before),
    after: nullableCleanText(parsed.after),
    section: nullableCleanText(parsed.section),
    change_type: cleanSlug(parsed.change_type) || "other",
    advisor_impact: nullableCleanText(parsed.advisor_impact),
    is_alert_worthy:
      typeof parsed.is_alert_worthy === "boolean" ? parsed.is_alert_worthy : true,
    confidence: ["low", "medium", "high"].includes(cleanSlug(parsed.confidence))
      ? cleanSlug(parsed.confidence)
      : "low",
    structured_diff: normalizeStructuredDiff(objectValue(parsed.structured_diff)),
    source: objectValue(parsed.source) || {},
    quality_flags: stringArray(parsed.quality_flags),
    generated_at: cleanShortText(parsed.generated_at) || "",
    generation_provider: cleanSlug(parsed.generation_provider) || "heuristic",
    generation_status: cleanSlug(parsed.generation_status) || "generated",
    generation_model: nullableCleanText(parsed.generation_model),
  };
}

function normalizeStructuredDiff(value) {
  const object = objectValue(value) || {};
  return {
    added_text: stringArray(object.added_text),
    removed_text: stringArray(object.removed_text),
    likely_section: nullableCleanText(object.likely_section),
    page_type: nullableCleanText(object.page_type),
    date_changes: stringArray(object.date_changes),
    amount_changes: stringArray(object.amount_changes),
    noise_flags: stringArray(object.noise_flags),
  };
}

function dedupeChangeSummaries(changes) {
  const seen = new Set();
  return changes.filter((change) => {
    const key = changeSummaryDedupeKey(change);
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function changeSummaryDedupeKey(change) {
  const details = change.change_details || change.changeDetails || null;
  const evidenceKey = changeEvidenceDedupeKey(details);
  if (evidenceKey && change.shared_award_id) {
    return "award:" + change.shared_award_id + "|" + evidenceKey;
  }

  const displayedSummary = displayChangeSummary(change.summary, change.source_url, details);
  const normalizedSummary = normalizeSummaryForDedupe(displayedSummary);
  if (!normalizedSummary) return "";

  const normalizedUrl = normalizeSourceUrlForDedupe(change.source_url);
  if (normalizedUrl) return "url:" + normalizedUrl + "|summary:" + normalizedSummary;

  return "award:" + (change.shared_award_id || "") + "|summary:" + normalizedSummary;
}

function changeEvidenceDedupeKey(changeDetails) {
  const details = parseChangeDetails(changeDetails);
  if (!details || !details.is_alert_worthy) return "";

  const evidenceParts = [
    details.before,
    details.after,
    ...details.structured_diff.added_text,
    ...details.structured_diff.removed_text,
    ...details.structured_diff.date_changes,
    ...details.structured_diff.amount_changes,
  ]
    .map(normalizeEvidenceForDedupe)
    .filter(Boolean);

  if (evidenceParts.length < 2) return "";
  return "evidence:" + evidenceParts.join("|");
}

function normalizeEvidenceForDedupe(value) {
  return cleanDisplayText(value)
    .toLowerCase()
    .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

function normalizeSummaryForDedupe(value) {
  return cleanDisplayText(value)
    .toLowerCase()
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?\b/g, "[date]")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "[date]")
    .replace(/\$\s?\d[\d,]*(?:\.\d{2})?\b/g, "[amount]")
    .replace(/[^a-z0-9[\]\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSourceUrlForDedupe(value) {
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
    return hostname + (pathname || "/");
  } catch {
    return clean.toLowerCase().replace(/\/+$/g, "");
  }
}

function isRelevantToAward(summary, awardName, sourceTitle, sourceUrl) {
  const normalizedSummary = summary.toLowerCase();
  const rootHomepage = isRootHomepage(sourceUrl);
  if (!rootHomepage) return true;

  const awardType = awardProgramType(awardName || sourceTitle || "");
  if (awardType === "scholarship" && /\binternship(s)?\b/.test(normalizedSummary)) {
    return false;
  }

  const tokens = meaningfulAwardTokens([awardName, sourceTitle].filter(Boolean).join(" "));
  if (tokens.some((token) => normalizedSummary.includes(token))) return true;

  return actionableAwardSignal(normalizedSummary);
}

function looksLowValueUpdate(update, summary) {
  const haystack = [
    summary,
    update.sourceTitle,
    update.sourceUrl,
    update.details?.change_type,
    update.details?.section,
    ...(update.details?.structured_diff?.added_text || []),
    ...(update.details?.structured_diff?.removed_text || []),
  ]
    .join(" ")
    .toLowerCase();
  const contentHaystack = [
    summary,
    update.sourceTitle,
    update.details?.change_type,
    update.details?.section,
    ...(update.details?.structured_diff?.added_text || []),
    ...(update.details?.structured_diff?.removed_text || []),
  ]
    .join(" ")
    .toLowerCase();
  const urlPath = pathForUrl(update.sourceUrl);
  const lowValuePath =
    /\/(news|events?|public_events?|calendar|stories?|story|profiles?|profile|alumni|members?|fellows?|recipients?|speakers?|press|blog)\b/i.test(
      urlPath,
    );
  const lowValueText =
    /\b(news|event|story|profile|alumni|featured fellow|recipient profile|speaker|webinar|symposium|conference|book club|press release|donors?|sponsors?|partners?)\b/i.test(
      haystack,
    );
  const noRequirementsChanged =
    /\bno\s+(?:application\s+)?(?:requirements?|deadlines?|eligibility|funding|application instructions?)[^.]{0,140}\bchanged\b/i.test(
      haystack,
    ) ||
    /\bno\s+application\s+requirements?,\s+deadlines?,\s+eligibility,\s+or\s+funding\s+text\s+changed\b/i.test(
      haystack,
    );
  if (noRequirementsChanged) return true;

  if (/^added date context:\s*past dates\b/i.test(summary)) return true;
  if (
    /\/funding\/awards\/\d{4}-/i.test(urlPath) &&
    /\b(list of funded projects|funded projects?|project was supported|award number)\b/i.test(haystack)
  ) {
    return true;
  }
  if (
    isRootHomepage(update.sourceUrl) &&
    /\b(happening now|projects funded|backers|funding rate|institutions)\b/i.test(haystack)
  ) {
    return true;
  }
  if (
    lowValuePath &&
    /\b(related posts?|previous next share|health\s*&\s*medicine|meet point flagship scholar)\b/i.test(
      haystack,
    )
  ) {
    return true;
  }
  if (/\bfeatured fellows?\b/i.test(haystack)) return true;
  if (/\b(indicates required fields|field is for validation purposes|submit x)\b/i.test(haystack)) {
    return true;
  }
  if (
    /\b(operating hours|open today|closed today|free sundays?|general admission|popular science book recommendations?|featured member|roll of arms|alumni corner|past events?|upcoming events?|ceremony|open hour|information sessions?|host an event|team-building|business solutions|certification program|sourcing risk assessment|cause marketing|5\s*g can help|strategic objectives|login via online app|iacet ceus?|silicon valley employee ownership symposium)\b/i.test(
      haystack,
    )
  ) {
    return true;
  }
  if (/\bdoes not appear to directly impact\b/i.test(haystack)) return true;
  if (/\bNSF IT systems?\b[^.]{0,180}\b(unavailable|unavailability)\b[^.]{0,180}\bMay 30\b/i.test(haystack)) {
    return true;
  }
  if (/\bnew search tool\b[^.]{0,80}\bDiscover\b[^.]{0,80}\bJune 24\b/i.test(haystack)) {
    return true;
  }
  if (/^added date context:\s*proposals accepted anytime posted\b/i.test(summary)) {
    return true;
  }
  if (
    /^The\s+.+\s+page\s+added\s+date\s+or\s+deadline\s+text:\s*[A-Za-z]{3,9}\s+\d{1,2}\.?$/i.test(
      summary,
    )
  ) {
    return true;
  }
  if (
    /^New funding amount language appeared:/i.test(summary) &&
    /\b(research\s+project\s+portal|nhpa|health\s+education|programs|faculty\/units|business,\s*government)\b/i.test(
      haystack,
    )
  ) {
    return true;
  }

  const archiveYearList = /\barchive\s+20\d{2}\s+20\d{2}\s+20\d{2}\b/i.test(haystack);
  const genericPostedProgramList =
    /\bposted\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i.test(
      haystack,
    ) &&
    /\bprogram\b/i.test(haystack);
  const awardTokens = meaningfulAwardTokens(update.awardName || "").filter(
    (token) => token.length >= 6,
  );
  const mentionsAwardToken = awardTokens.some((token) => contentHaystack.includes(token));
  const actionable = actionableAwardSignal(haystack);
  const strippedRawChange = stripRawChangeLead(summary);
  if (strippedRawChange !== summary && !actionableAwardSignal(strippedRawChange)) return true;

  if ((archiveYearList || genericPostedProgramList) && !mentionsAwardToken) return true;
  if ((lowValuePath || lowValueText) && !actionable) return true;
  if (update.details?.change_type === "content_update" && !actionable) return true;
  if (isRootHomepage(update.sourceUrl) && !actionable) return true;
  return false;
}

function actionableAwardSignal(value) {
  return /\b(applications?|applicants?|apply|deadline|due|eligible|eligibility|requirements?|recommendations?|transcripts?|essays?|interviews?|tuition|stipend|funding|grants?|fellowships?|scholarships?|award amount|admission|selection|nomination|candidates?|submit|submission|opens?|reopens?|closes?|citizenship|gpa|pdf|guide|instructions?)\b/i.test(
    value,
  );
}

function pathForUrl(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}

function isRootHomepage(sourceUrl) {
  if (!sourceUrl) return false;
  try {
    const url = new URL(sourceUrl);
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

function looksUnclearPlainEnglish(summary) {
  const clean = cleanDisplayText(summary);
  const lower = clean.toLowerCase();
  if (!clean) return true;
  if (clean.length < 28) return true;
  if (clean.length > 520) return true;
  if (looksLikeTruncatedFragment(clean)) return true;
  if (hasRawScrapeSignals(clean)) return true;
  if (/\barchive\s+20\d{2}\s+20\d{2}\s+20\d{2}\b/i.test(clean)) return true;
  if (/^added date context:\s*/i.test(clean) && /\bposted\b/i.test(clean)) return true;
  if (/\bnext required due date:\s*$/i.test(clean)) return true;
  if (/https?:\/\/|www\.[a-z0-9.-]+\.[a-z]{2,}/i.test(clean)) return true;
  if (/\b(null|undefined|nan)\b/i.test(clean)) return true;
  if (
    lower.includes("page was updated") ||
    lower.includes("page has been updated") ||
    lower.includes("something changed") ||
    lower.includes("content was updated") ||
    lower.includes("page text updated")
  ) {
    return true;
  }
  if (
    /^The\s+.+\s+page\s+(?:has\s+)?(?:added|removed|changed)\b/i.test(clean) &&
    clean.length > 140
  ) {
    return true;
  }
  return false;
}

function looksLikeTruncatedFragment(summary) {
  const normalized = summary.toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);
  const lastWord = words.at(-1)?.replace(/[^a-z0-9]+/g, "") || "";
  const quoteCount = (summary.match(/"/g) || []).length;

  return (
    words.length < 6 ||
    (quoteCount % 2 === 1 && summary.length < 120) ||
    /^(the|on the|in the|from the)\s+"?[\w\s-]{0,40}$/.test(normalized) ||
    /^(the|on the|in the|from the)\s+[a-z]{1,8}$/.test(normalized) ||
    /^(a|an|the|and|or|of|on|to|for|from|with|in|by|through|into|about|over|under|must|should|can|will|may)$/.test(lastWord)
  );
}

function looksLikeBoilerplateChange(summary) {
  const normalized = summary.toLowerCase();
  return (
    /(social media|facebook|instagram|twitter|x\.com|linkedin|youtube|@[\w.-]+)/.test(normalized) ||
    /(required statements|copyright|all rights reserved|privacy|cookie|newsletter|subscribe)/.test(normalized) ||
    /\b(suite|blvd|boulevard|street|avenue)\b/.test(normalized)
  );
}

function isInstitutionalDiscoveryUrl(value) {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return institutionalDiscoveryHosts.has(hostname);
  } catch {
    return false;
  }
}

function isMonitorableOfficialSource(source) {
  if (!source.url || isInstitutionalDiscoveryUrl(source.url)) return false;
  if (isHardBlockedOfficialSourceUrl(source.url)) return false;
  return isProtectedOfficialSourcePageType(source.page_type) || !isClearlyNonAwardSourceUrl(source.url);
}

function isProtectedOfficialSourcePageType(value) {
  return protectedOfficialSourcePageTypes.has(String(value || "").toLowerCase());
}

function isClearlyNonAwardSourceUrl(value) {
  if (!value) return false;

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const fullUrl = url.toString();
    if (!["http:", "https:"].includes(url.protocol)) return true;
    if (cmsAdminHosts.has(hostname)) return true;
    if (phoneNumberPathSegment.test(decodeURIComponent(url.pathname))) return true;
    if (hardNonAwardPath.test(url.pathname) || trackingQuery.test(fullUrl)) return true;
    if (listingPath.test(url.pathname) && !awardRelatedText.test(fullUrl)) return true;
    return nonMonitorableAsset.test(url.pathname);
  } catch {
    return true;
  }
}

function isHardBlockedOfficialSourceUrl(value) {
  if (!value) return false;

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const fullUrl = url.toString();
    if (!["http:", "https:"].includes(url.protocol)) return true;
    if (cmsAdminHosts.has(hostname)) return true;
    if (phoneNumberPathSegment.test(decodeURIComponent(url.pathname))) return true;
    return hardNonAwardPath.test(url.pathname) || trackingQuery.test(fullUrl);
  } catch {
    return true;
  }
}

function rewritePathSourceLabel(summary, sourceUrl) {
  if (!sourceUrl) return summary;
  return summary.replace(
    /^The\s+(\/[^\s]+|[a-z0-9-]+(?:\/[a-z0-9-]+)+\/?)\s+page\s+/i,
    () => "The " + readableSourceTitle(null, sourceUrl) + " page ",
  );
}

function readableSourceTitle(sourceTitle, sourceUrl) {
  const cleanTitle = cleanDisplayText(sourceTitle);
  const titleUrl = safeUrl(cleanTitle);
  if (titleUrl) return readableTitleFromUrl(titleUrl);
  if (/^\/+$/.test(cleanTitle)) return "Homepage";
  if (
    cleanTitle &&
    !/^(source page|homepage|other source)$/i.test(cleanTitle) &&
    !isGenericActionTitle(cleanTitle) &&
    !looksLikeUrlPathTitle(cleanTitle)
  ) {
    return cleanTitle;
  }

  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      return readableTitleFromUrl(url);
    } catch {
      // Fall through to generic label.
    }
  }

  return "source";
}

function isGenericActionTitle(value) {
  return /^(apply|applications?|learn more|read more|view more|more information|details?|click here|here|tips here\.?)$/i.test(
    value.trim(),
  );
}

function readableTitleFromUrl(url) {
  const segments = meaningfulUrlSegments(url);
  const segment = segments.at(-1);
  if (!segment) return "Homepage";
  if (/^application-tips-/i.test(segment)) {
    return formatPathSegment(segment.replace(/^application-tips-/i, "")) + " Application Tips";
  }
  if (/^(apply|application)$/i.test(segment)) {
    const context = segments.slice(0, -1).at(-1);
    return context ? formatPathSegment(context) + " Application" : "Application Page";
  }
  if (/^(tips|tips-here)$/i.test(segment)) {
    const context = segments.slice(0, -1).at(-1);
    return context ? formatPathSegment(context) + " Tips" : "Tips";
  }
  return formatPathSegment(segment);
}

function meaningfulUrlSegments(url) {
  return url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter(
      (segment) =>
        segment.length > 1 &&
        !/^(page|pages|resources?|view|programs?|awards?|scholarships?|fellowships?|grants?)$/i.test(
          segment,
        ),
    );
}

function formatPathSegment(segment) {
  const decoded = decodeURIComponent(segment).replace(/\.(html?|php|aspx?|pdf)$/i, "");
  const cleaned = decoded
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Page";

  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (/^(faq|faqs|pdf|nsf|grfp|usa|us|uk|phd|nasa|rd|r&d)$/i.test(word)) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function looksLikeUrlPathTitle(value) {
  const clean = String(value || "").trim();
  return (
    /^\/+$/.test(clean) ||
    /^\/[^/]+(?:\/[^/]+)*\/?$/i.test(clean) ||
    /^[a-z0-9-]+(?:\/[a-z0-9-]+)+\/?$/i.test(clean)
  );
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hasRawScrapeSignals(value) {
  return (
    looksLikeSourceAccessError(value) ||
    hasRawMarkupSignals(value) ||
    hasSeoInstrumentationSignals(value) ||
    hasJumpLinkHeadingPrefixSignals(value) ||
    /\b(indicates required fields|field is for validation purposes|submit x)\b/i.test(String(value || "")) ||
    /\b(learn more|read more|click here|skip to|main menu|toggle menu|toggle page navigation|search menu|read current issue|cart|dismiss|login|copyright|privacy policy|all rights reserved|facebook|instagram|x\.com|twitter|linkedin|youtube|subscribe|newsletter)\b/i.test(String(value || "")) ||
    hasNavigationBoilerplate(value) ||
    hasStorefrontBoilerplate(value)
  );
}

function looksLikeSourceAccessError(value) {
  const clean = cleanDisplayText(value);
  if (!clean) return false;
  return (
    /\b(?:fehler|error)\s*(?:401|403|404|410|429|50[0-4])\b/i.test(clean) ||
    /\b(access denied|zugriff verboten|forbidden|not found|page not found|service unavailable|too many requests)\b/i.test(clean) ||
    /\bthe access to this directory\/page is restricted\b/i.test(clean) ||
    /\bHTTP\/1\.1\s+(?:401|403|404|410|429|50[0-4])\b/i.test(clean)
  );
}

function hasJumpLinkHeadingPrefixSignals(value) {
  const clean = cleanDisplayText(value);
  return /\bTop\s+(?:Applications?|The Selection Process|Selection Process|Eligibility|Requirements?|Deadlines?|Timeline|FAQs?|Funding|References?|Courses?)\b/.test(
    clean,
  );
}

function hasSeoInstrumentationSignals(value) {
  const clean = cleanDisplayText(value);
  return (
    /\bbe_ixf\b/i.test(clean) ||
    /\bym_20\d{4}\s+d_\d{2}\b/i.test(clean) ||
    /\bphp_sdk(?:_\d+(?:\.\d+){1,3})?\b/i.test(clean) ||
    /\bct_\d+\s+be_ixf\b/i.test(clean)
  );
}

function hasRawMarkupSignals(value) {
  const clean = cleanDisplayText(value);
  return (
    /<\/?(?:picture|source|img|script|style|div|span|section|article|figure|figcaption|a|p|br|ul|ol|li|svg|path)\b/i.test(clean) ||
    /\b(?:srcset|classname|referrerpolicy|loading|sizes|alt|href|style)=["'][^"']{8,}/i.test(clean) ||
    /https?:\/\/[^\s"']+\.(?:jpg|jpeg|png|gif|webp|svg)(?:[?#][^\s"']*)?/i.test(clean)
  );
}

function hasStorefrontBoilerplate(value) {
  const clean = cleanDisplayText(value);
  return (
    /\b(view item|featured products?|shop for materials?|add to cart|checkout|subtotal|merchandise)\b/i.test(clean) ||
    /\bprice:\s*\$\s?\d/i.test(clean)
  );
}

function hasNavigationBoilerplate(value) {
  const clean = cleanDisplayText(value);
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

function cleanDisplayText(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/([.!?])(?=[A-Z0-9])/g, "$1 ")
    .replace(/([a-z])([A-Z][a-z])/g, "$1 $2")
    .replace(/\bArticle\s+\d+\s+Min\s+Read\b/gi, "")
    .replace(/\bArticle\s+\d+\s+hours?\s+ago\s+\d+\s+min\s+read\b/gi, "")
    .replace(/\b\d+\s+min\s+read\b/gi, "")
    .replace(/\s*;\s*/g, "; ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])\s*-\s*(?=The\b)/g, "$1 ")
    .replace(/\bM\.\s*D\./g, "M.D.")
    .replace(/\bPh\.\s*D\./gi, "Ph.D.")
    .replace(/\bU\.\s*S\./g, "U.S.")
    .replace(/\bU\.\s*K\./g, "U.K.")
    .replace(/\bi\.\s*e\./gi, "i.e.")
    .replace(/\be\.\s*g\./gi, "e.g.")
    .replace(/\s+/g, " ")
    .trim();
}

function nullableCleanText(value) {
  const clean = cleanShortText(value);
  return clean || null;
}

function cleanShortText(value) {
  return cleanDisplayText(value).slice(0, 1200);
}

function cleanSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => cleanShortText(item)).filter(Boolean)
    : [];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseJsonObject(value) {
  if (objectValue(value)) return value;
  const clean = cleanDisplayText(String(value || ""))
    .replace(/^\x60{3}(?:json)?\s*/i, "")
    .replace(/\s*\x60{3}$/i, "");
  if (!clean) return null;

  try {
    const parsed = JSON.parse(clean);
    return objectValue(parsed);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return objectValue(JSON.parse(match[0]));
    } catch {
      return null;
    }
  }
}

async function withRetry(label, fn) {
  let lastError = null;
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount) break;
      const delay = retryDelayMs * attempt;
      console.warn(
        label +
          " failed on attempt " +
          attempt +
          "; retrying in " +
          delay +
          "ms: " +
          errorMessage(error),
      );
      await sleep(delay);
    }
  }
  const message = errorMessage(lastError) || "Unknown error";
  const wrapped = new Error(label + " failed after " + retryCount + " attempts: " + message);
  wrapped.cause = lastError;
  throw wrapped;
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, rawValue] = arg.slice(2).split("=");
    parsed[key] = rawValue === undefined ? true : rawValue;
  }
  return parsed;
}

function loadEnvFile(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          const key = line.slice(0, index).trim();
          const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
          return [key, value];
        }),
    );
  } catch {
    return {};
  }
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function readLimit(value, fallback) {
  if (String(value || "").toLowerCase() === "all") return Number.POSITIVE_INFINITY;
  return positiveInt(value, fallback);
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function unique(values) {
  return [...new Set(values.map((value) => cleanShortText(value)).filter(Boolean))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeLogAuditProgress(count, total, stats) {
  if (!progressEvery || count % progressEvery !== 0) return;
  console.log(
    "audit progress " +
      count +
      "/" +
      total +
      " checkedLive=" +
      stats.checkedLive +
      " rejected=" +
      stats.rejected +
      " manualReview=" +
      stats.manualReview +
      " kept=" +
      stats.kept,
  );
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message =
      "message" in error && String(error.message || "").trim()
        ? String(error.message)
        : JSON.stringify(error);
    return message && message !== "{}" ? message : Object.prototype.toString.call(error);
  }
  return String(error);
}
