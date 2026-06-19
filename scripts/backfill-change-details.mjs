#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const sentenceDotPlaceholder = "__AP_SENTENCE_DOT__";
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, args.env) : resolve(root, ".env.local");
const env = { ...loadEnvFile(envPath), ...process.env };
const apply = args.apply === true || args.apply === "true";
const force = args.force === true || args.force === "true";
const limit = positiveInt(args.limit, 0);
const days = args.days === "all" ? 0 : positiveInt(args.days, 30);
const aiProvider = selectAiProvider(args["ai-provider"] || env.AI_PROVIDER || "auto");
const useAi = args.ai !== "false" && Boolean(aiProvider);
const logEvery = positiveInt(args["log-every"], 100);
const retryCount = positiveInt(args.retries, 4);
const retryDelayMs = positiveInt(args["retry-delay-ms"], 1000);
const targetIdSet = loadTargetIdSet(args.ids, args["ids-file"]);
const outputPath = args.output || join(root, "reports", "change-details-backfill-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createSupabaseServiceClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
);
const since = days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null;

console.log("Backfilling change_details; apply=" + apply + "; force=" + force + "; days=" + (days || "all") + "; ai=" + (useAi ? aiProvider : "false") + "; ids=" + (targetIdSet ? targetIdSet.size : "all") + ".");

const [sharedChanges, localChanges] = await Promise.all([
  loadChanges("shared_award_change_events"),
  loadChanges("change_events"),
]);
const sharedTargets = targetRows(sharedChanges);
const localTargets = targetRows(localChanges);
const allTargets = [
  ...sharedTargets.map((row) => ({ kind: "shared", row })),
  ...localTargets.map((row) => ({ kind: "local", row })),
];
const limitedTargets = limit > 0 ? allTargets.slice(0, limit) : allTargets;
const sharedSnapshotIds = snapshotIds(limitedTargets.filter((target) => target.kind === "shared").map((target) => target.row));
const localSnapshotIds = snapshotIds(limitedTargets.filter((target) => target.kind === "local").map((target) => target.row));
const [sharedSnapshots, localSnapshots, monitors, awards] = await Promise.all([
  loadSnapshots("shared_award_source_snapshots", sharedSnapshotIds),
  loadSnapshots("monitor_snapshots", localSnapshotIds),
  loadMonitors(localTargets.map((row) => row.monitor_id).filter(Boolean)),
  loadSharedAwards(sharedTargets.map((row) => row.shared_award_id).filter(Boolean)),
]);
const sharedSnapshotById = new Map(sharedSnapshots.map((snapshot) => [snapshot.id, snapshot]));
const localSnapshotById = new Map(localSnapshots.map((snapshot) => [snapshot.id, snapshot]));
const monitorById = new Map(monitors.map((monitor) => [monitor.id, monitor]));
const awardNameById = new Map(awards.map((award) => [award.id, award.name]));
const stats = {
  scanned: sharedChanges.length + localChanges.length,
  targeted: limitedTargets.length,
  generated: 0,
  applied: 0,
  skippedExisting: allTargets.length - limitedTargets.length,
  skippedMissingSnapshots: 0,
  failed: 0,
};
const results = [];
let processed = 0;

for (const target of limitedTargets) {
  processed += 1;
  try {
    const snapshots = target.kind === "shared" ? sharedSnapshotById : localSnapshotById;
    const previous = target.row.previous_snapshot_id ? snapshots.get(target.row.previous_snapshot_id) : null;
    const next = target.row.new_snapshot_id ? snapshots.get(target.row.new_snapshot_id) : null;

    if (!previous?.text_sample || !next?.text_sample) {
      stats.skippedMissingSnapshots += 1;
      results.push(resultRow(target, "missing_snapshots", target.row.summary, null));
      continue;
    }

    const context = contextForTarget(target, monitorById, awardNameById);
    let details = buildChangeDetails(previous.text_sample, next.text_sample, context, target.row.summary);
    if (useAi && details.is_alert_worthy) {
      details = await generateAiDetails(previous.text_sample, next.text_sample, context, details);
    }

    stats.generated += 1;
    results.push(resultRow(target, apply ? "generated_apply" : "generated_dry_run", target.row.summary, details));

    if (apply) {
      const table = target.kind === "shared" ? "shared_award_change_events" : "change_events";
      await withRetry("update " + table + " " + target.row.id, async () => {
        const { error } = await supabase
          .from(table)
          .update({ summary: details.reader_summary, change_details: details })
          .eq("id", target.row.id);
        if (error) throw error;
      });
      stats.applied += 1;
    }
    if (logEvery > 0 && (processed % logEvery === 0 || processed === limitedTargets.length)) {
      console.log(
        "progress " +
          processed +
          "/" +
          limitedTargets.length +
          " generated=" +
          stats.generated +
          " applied=" +
          stats.applied +
          " failed=" +
          stats.failed,
      );
    }
  } catch (error) {
    stats.failed += 1;
    results.push({
      kind: target.kind,
      id: target.row.id,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    if (logEvery > 0 && (processed % logEvery === 0 || processed === limitedTargets.length)) {
      console.log(
        "progress " +
          processed +
          "/" +
          limitedTargets.length +
          " generated=" +
          stats.generated +
          " applied=" +
          stats.applied +
          " failed=" +
          stats.failed,
      );
    }
  }
}

mkdirSync(resolve(outputPath, ".."), { recursive: true });
writeFileSync(outputPath, JSON.stringify({ stats, results }, null, 2));
console.log("Wrote " + outputPath);
console.log(JSON.stringify(stats, null, 2));

async function loadChanges(table) {
  const columns = table === "shared_award_change_events"
    ? "id, shared_award_id, source_title, source_url, source_page_type, previous_snapshot_id, new_snapshot_id, summary, change_details, detected_at"
    : "id, monitor_id, previous_snapshot_id, new_snapshot_id, summary, change_details, detected_at";
  const rows = [];
  const pageSize = 1000;
  const maxRows = limit > 0 ? Math.max(limit, 100) : Number.POSITIVE_INFINITY;

  for (let from = 0; rows.length < maxRows; from += pageSize) {
    const data = await withRetry("load " + table + " rows " + from, async () => {
      let query = supabase
        .from(table)
        .select(columns)
        .order("detected_at", { ascending: false })
        .range(from, from + pageSize - 1);

      if (since) query = query.gte("detected_at", since);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    });

    if (!data.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }

  return rows.slice(0, maxRows);
}

function targetRows(rows) {
  return rows.filter((row) => {
    if (targetIdSet && !targetIdSet.has(row.id)) return false;
    return force || !hasStructuredDetails(row.change_details);
  });
}

function hasStructuredDetails(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.reader_summary === "string" &&
      value.structured_diff,
  );
}

function snapshotIds(rows) {
  return [...new Set(rows.flatMap((row) => [row.previous_snapshot_id, row.new_snapshot_id]).filter(Boolean))];
}

async function loadSnapshots(table, ids) {
  return loadInChunks(table, "id, text_sample", ids);
}

async function loadMonitors(ids) {
  return loadInChunks("monitors", "id, label, url, page_type", ids);
}

async function loadSharedAwards(ids) {
  return loadInChunks("shared_awards", "id, name", ids);
}

async function loadInChunks(table, columns, ids) {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return [];
  const rows = [];
  for (let index = 0; index < uniqueIds.length; index += 100) {
    const chunk = uniqueIds.slice(index, index + 100);
    const data = await withRetry("load " + table + " chunk " + index, async () => {
      const { data, error } = await supabase.from(table).select(columns).in("id", chunk);
      if (error) throw error;
      return data || [];
    });
    rows.push(...data);
  }
  return rows;
}

function contextForTarget(target, monitorById, awardNameById) {
  if (target.kind === "local") {
    const monitor = monitorById.get(target.row.monitor_id) || {};
    return {
      award_name: null,
      source_title: monitor.label || "Tracked award page",
      source_url: monitor.url || null,
      page_type: monitor.page_type || null,
    };
  }

  return {
    award_name: awardNameById.get(target.row.shared_award_id) || null,
    source_title: target.row.source_title || null,
    source_url: target.row.source_url || null,
    page_type: target.row.source_page_type || null,
  };
}

function buildChangeDetails(previousText, nextText, context, fallbackSummary) {
  const previousClean = normalizeText(previousText);
  const nextClean = normalizeText(nextText);
  const applicationStatus = applicationOpenStatusChange(previousClean, nextClean);
  const addedText = dedupeText([
    applicationStatus?.after,
    ...changedSentences(previousClean, nextClean, "added").slice(0, 5),
  ].filter(Boolean));
  const removedText = dedupeText([
    applicationStatus?.before,
    ...changedSentences(previousClean, nextClean, "removed").slice(0, 4),
  ].filter(Boolean));
  const previousDates = new Set(contextualDatePhrases(previousClean));
  const nextDates = new Set(contextualDatePhrases(nextClean));
  const previousAmounts = new Set(contextualMoneyPhrases(previousClean));
  const nextAmounts = new Set(contextualMoneyPhrases(nextClean));
  const addedDates = [...nextDates].filter((date) => !previousDates.has(date));
  const removedDates = [...previousDates].filter((date) => !nextDates.has(date));
  const addedAmounts = [...nextAmounts].filter((amount) => !previousAmounts.has(amount));
  const removedAmounts = [...previousAmounts].filter((amount) => !nextAmounts.has(amount));
  const sampleExpansion = isLikelySampleExpansion(previousClean, nextClean);
  const changedText = [...addedText, ...removedText].join(" ");
  const noiseFlags = [];
  if (sampleExpansion) noiseFlags.push("sample_expansion");
  if (looksLikeSourceAccessError(previousClean) || looksLikeSourceAccessError(nextClean)) {
    noiseFlags.push("source_access_error");
  }
  if (
    looksLikeRecipientNewsOrPressChange({
      changedText,
      previousText: previousClean,
      nextText: nextClean,
      addedDates,
      removedDates,
      addedAmounts,
      removedAmounts,
    })
  ) {
    noiseFlags.push("recipient_news_change");
  }
  const structuredDiff = {
    added_text: addedText,
    removed_text: removedText,
    likely_section: inferSection(addedText[0] || removedText[0] || context.source_title || ""),
    page_type: context.page_type || null,
    date_changes: [...addedDates.map((date) => "Added " + date), ...removedDates.map((date) => "Removed " + date)],
    amount_changes: [...addedAmounts.map((amount) => "Added " + amount), ...removedAmounts.map((amount) => "Removed " + amount)],
    noise_flags: noiseFlags,
  };
  const before = removedText[0] || null;
  const after = addedText[0] || null;
  const changeType = inferChangeType(structuredDiff, fallbackSummary);
  const readerSummary = summarizeForReader(context, structuredDiff, before, after, fallbackSummary);
  const flags = qualityFlags(readerSummary, before, after, structuredDiff);
  const alertWorthy = !hasHardQualityFlag(flags);

  return {
    reader_summary: alertWorthy ? readerSummary : "No award-relevant wording changed in the stored excerpt.",
    before: alertWorthy ? before : null,
    after: alertWorthy ? after : null,
    section: structuredDiff.likely_section,
    change_type: alertWorthy ? changeType : "noise",
    advisor_impact: alertWorthy ? advisorImpact(changeType, structuredDiff) : null,
    is_alert_worthy: alertWorthy,
    confidence: alertWorthy ? structuredDiff.date_changes.length || structuredDiff.amount_changes.length ? "high" : addedText.length || removedText.length ? "medium" : "low" : "low",
    structured_diff: structuredDiff,
    source: context,
    quality_flags: flags,
    generated_at: new Date().toISOString(),
    generation_provider: "heuristic",
    generation_status: alertWorthy ? "generated" : "rejected",
    generation_model: null,
  };
}

function summarizeForReader(context, diff, before, after, fallbackSummary) {
  const sourceName = context.source_title || context.award_name || "source";
  if (after && /\bapplications?\b.*\bnow open\b/i.test(after)) {
    return "The " + sourceName + " page now says applications are open: " + after;
  }
  if (before && after) return "The " + sourceName + " page changed wording from \"" + truncate(before, 140) + "\" to \"" + truncate(after, 170) + "\".";
  if (after) return "The " + sourceName + " page added new wording: " + after;
  if (before) return "The " + sourceName + " page removed wording: " + before;
  if (diff.date_changes[0]) return "The " + sourceName + " page added date or deadline text: " + diff.date_changes[0].replace(/^(Added|Removed)\s+/i, "") + ".";
  if (diff.amount_changes[0]) return "The " + sourceName + " page added funding amount text: " + diff.amount_changes[0].replace(/^(Added|Removed)\s+/i, "") + ".";
  return cleanText(fallbackSummary) || "No award-relevant wording changed in the stored excerpt.";
}

async function generateAiDetails(previousText, nextText, context, fallback) {
  try {
    if (aiProvider === "gemini") return generateGeminiDetails(previousText, nextText, context, fallback);
    if (aiProvider === "openai") return generateOpenAiDetails(previousText, nextText, context, fallback);
  } catch {
    return withGenerationMetadata(fallback, aiProvider || "heuristic", "fallback", modelForProvider(aiProvider));
  }
  return fallback;
}

async function generateGeminiDetails(previousText, nextText, context, fallback) {
  const model = env.GEMINI_SUMMARY_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const data = await withRetry("gemini summary", async () => {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt() }] },
          contents: [{ role: "user", parts: [{ text: userPrompt(previousText, nextText, context, fallback) }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 700,
            responseMimeType: "application/json",
            responseSchema: changeDetailsResponseSchema(),
          },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) throw new Error("Gemini HTTP " + response.status);
      return null;
    }
    return response.json();
  });
  if (!data) return withGenerationMetadata(fallback, "gemini", "fallback", model);
  return normalizeAiDetails(extractGeminiText(data), fallback, context, "gemini", model);
}

async function generateOpenAiDetails(previousText, nextText, context, fallback) {
  const data = await withRetry("openai summary", async () => {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + env.OPENAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        model: env.OPENAI_SUMMARY_MODEL || env.OPENAI_DISCOVERY_MODEL || "gpt-4.1-mini",
        instructions: systemPrompt(),
        input: [{ role: "user", content: [{ type: "input_text", text: userPrompt(previousText, nextText, context, fallback) }] }],
        text: { format: { type: "json_object" } },
        max_output_tokens: 700,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) throw new Error("OpenAI HTTP " + response.status);
      return null;
    }
    return response.json();
  });
  if (!data) return withGenerationMetadata(fallback, "openai", "fallback", env.OPENAI_SUMMARY_MODEL || env.OPENAI_DISCOVERY_MODEL || "gpt-4.1-mini");
  return normalizeAiDetails(extractResponseText(data), fallback, context, "openai", env.OPENAI_SUMMARY_MODEL || env.OPENAI_DISCOVERY_MODEL || "gpt-4.1-mini");
}

function normalizeAiDetails(text, fallback, context, provider, model) {
  const parsed = parseJsonObject(text);
  if (!parsed) return withGenerationMetadata(addFlag(fallback, "ai_invalid_json"), provider, "invalid_json", model);
  const candidate = {
    reader_summary: cleanText(parsed.reader_summary) || fallback.reader_summary,
    before: cleanNullable(parsed.before) || fallback.before,
    after: cleanNullable(parsed.after) || fallback.after,
    section: cleanNullable(parsed.section) || fallback.section,
    change_type: cleanSlug(parsed.change_type) || fallback.change_type,
    advisor_impact: cleanNullable(parsed.advisor_impact) || fallback.advisor_impact,
    is_alert_worthy: typeof parsed.is_alert_worthy === "boolean" ? parsed.is_alert_worthy : fallback.is_alert_worthy,
    confidence: ["low", "medium", "high"].includes(cleanSlug(parsed.confidence)) ? cleanSlug(parsed.confidence) : fallback.confidence,
    structured_diff: fallback.structured_diff,
    source: context,
    quality_flags: [],
    generated_at: new Date().toISOString(),
    generation_provider: provider,
    generation_status: "generated",
    generation_model: model,
  };
  candidate.quality_flags = qualityFlags(candidate.reader_summary, candidate.before, candidate.after, candidate.structured_diff);
  if (!candidate.is_alert_worthy || hasHardQualityFlag(candidate.quality_flags)) {
    return withGenerationMetadata(addFlag(fallback, "ai_rejected"), provider, "rejected", model);
  }
  return candidate;
}

function systemPrompt() {
  return "You summarize official award webpage changes for scholarship advisors. Return valid JSON only with keys reader_summary, before, after, section, change_type, advisor_impact, is_alert_worthy, confidence. Use null when unknown. Use only provided excerpts and structured diff. If either excerpt is an error, access denied, forbidden, not found, or other source access page, set is_alert_worthy=false. If the only change is a news, press, alumni-highlight, or shared-from item about a recipient, finalist, or student being selected for an award, set is_alert_worthy=false. If the only change is rotating testimonials, fellows, recipients, speaker bios, staff/team rosters, or profile/story text, keep it as a low-impact content_update and summarize the category of content that changed instead of quoting the text. Make reader_summary a clear one- or two-sentence explanation for a scholarship advisor. For broad content rotations, describe the category of content that changed and explicitly say whether deadlines, eligibility, funding, or application requirements changed. For concrete award changes, state the practical before/after meaning instead of dumping raw scraped text. Reject raw scrape signals such as LEARN MORE, orphan punctuation, vague page-updated wording, and changes with no concrete award-relevant fact.";
}

function userPrompt(previousText, nextText, context, fallback) {
  return [
    "Award: " + (context.award_name || "Unknown award"),
    "Source title: " + (context.source_title || "Unknown source"),
    "Source URL: " + (context.source_url || "Unknown URL"),
    "Page type: " + (context.page_type || "unknown"),
    "Structured diff: " + JSON.stringify(fallback.structured_diff),
    "Fallback: " + JSON.stringify({ reader_summary: fallback.reader_summary, before: fallback.before, after: fallback.after, section: fallback.section, change_type: fallback.change_type, advisor_impact: fallback.advisor_impact, is_alert_worthy: fallback.is_alert_worthy, confidence: fallback.confidence }),
    "Previous excerpt:\n" + previousText.slice(0, 12000),
    "New excerpt:\n" + nextText.slice(0, 12000),
    "Return one JSON object. The reader_summary must explain the changed fact directly, not as a scrape fragment or word-level diff.",
  ].join("\n\n");
}

function qualityFlags(summary, before, after, diff) {
  const flags = [...(diff.noise_flags || [])];
  const text = [summary, before, after].filter(Boolean).join(" ");
  if (hasRawScrapeSignals(text)) flags.push("raw_scrape_signal");
  if (/^[\s:;,.!?|/\\()[\]{}'\"-]+$/.test(cleanText(summary))) flags.push("orphan_punctuation");
  if (isVague(summary)) flags.push("vague_summary");
  if (hasIndistinctTruncatedSnippets(before, after)) flags.push("indistinct_truncated_snippet");
  if (hasFormatOnlySnippetChange(before, after)) flags.push("format_only_change");
  if (hasContextOnlySnippetChange(before, after, diff)) flags.push("context_only_change");
  if (
    looksLikeRecipientNewsOrPressChange({
      changedText: [before, after, ...(diff.added_text || []), ...(diff.removed_text || [])]
        .filter(Boolean)
        .join(" "),
      previousText: (diff.removed_text || []).join(" "),
      nextText: (diff.added_text || []).join(" "),
      addedDates: (diff.date_changes || []).filter((change) => /^Added\s+/i.test(change)),
      removedDates: (diff.date_changes || []).filter((change) => /^Removed\s+/i.test(change)),
      addedAmounts: (diff.amount_changes || []).filter((change) => /^Added\s+/i.test(change)),
      removedAmounts: (diff.amount_changes || []).filter((change) => /^Removed\s+/i.test(change)),
    })
  ) {
    flags.push("recipient_news_change");
  }
  if (!before && !after && !diff.date_changes.length && !diff.amount_changes.length) flags.push("no_actual_changed_fact");
  if (hasUnsupportedStructuredFact(before, after, diff)) flags.push("unsupported_structured_fact");
  return [...new Set(flags)];
}

function hasHardQualityFlag(flags) {
  return flags.some((flag) => ["ai_invalid_json", "source_access_error", "raw_scrape_signal", "orphan_punctuation", "vague_summary", "no_actual_changed_fact", "sample_expansion", "unsupported_structured_fact", "indistinct_truncated_snippet", "format_only_change", "context_only_change", "recipient_news_change"].includes(flag));
}

function hasIndistinctTruncatedSnippets(before, after) {
  if (!before || !after) return false;
  const cleanBefore = normalizeComparableSnippet(before);
  const cleanAfter = normalizeComparableSnippet(after);
  if (!cleanBefore || !cleanAfter) return false;
  if (cleanBefore === cleanAfter) return true;
  const shorter = cleanBefore.length <= cleanAfter.length ? cleanBefore : cleanAfter;
  const longer = cleanBefore.length > cleanAfter.length ? cleanBefore : cleanAfter;
  if (shorter.length >= 160 && longer.startsWith(shorter.slice(0, 160))) {
    return true;
  }
  return shorter.length >= 40 && longer.startsWith(shorter) && looksLikeIncompletePrefixSnippet(shorter);
}

function normalizeComparableSnippet(value) {
  return normalizeText(String(value || "")).replace(/\.\.\.$/, "").replace(/[.。]+$/g, "").toLowerCase();
}

function looksLikeIncompletePrefixSnippet(value) {
  const clean = normalizeText(String(value || "")).replace(/\.\.\.$/, "").trim();
  if (!clean) return false;
  if (/[.!?)]["']?$/.test(clean)) return false;
  if (/\$\s?\d|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\b/i.test(clean)) {
    return false;
  }
  return (clean.match(/[a-z0-9]+/gi) || []).length >= 5;
}

function hasApplicationRequirementSignal(value) {
  return /\b(deadline|due|applications?\s+(?:open|close|due)|apply by|submit(?:ted)? by|eligib(?:le|ility)|must submit|required|requirements?|recommendation|transcript|essay|interview|tuition|stipend|award amount|funding amount|citizenship|gpa)\b/i.test(
    String(value || ""),
  );
}

function looksLikeRecipientNewsOrPressChange(input) {
  if (
    input.addedDates?.length ||
    input.removedDates?.length ||
    input.addedAmounts?.length ||
    input.removedAmounts?.length
  ) {
    return false;
  }
  if (hasApplicationRequirementSignal(input.changedText)) return false;

  const changedClean = normalizeText(String(input.changedText || ""));
  if (
    changedClean &&
    !looksLikeRecipientNewsOrPressText(changedClean) &&
    !/\b(department of state scholarship|(?:his|her|their) language skills?|work on (?:his|her|their) language skills?|travel to|will spend)\b/i.test(changedClean)
  ) {
    return false;
  }

  return looksLikeRecipientNewsOrPressText(
    `${input.changedText || ""} ${input.previousText || ""} ${input.nextText || ""}`,
  );
}

function looksLikeRecipientNewsOrPressText(value) {
  const clean = normalizeText(String(value || ""));
  if (!clean) return false;

  const pressSignals = /\b(latest news|news|press release|in the press|shared from|alumni highlight|student profile|recipient profile)\b/i.test(clean);
  const recipientSignals = /\b(selected for|selected as|has been selected for|named finalist|named a finalist|receives? federal help|students? awarded scholarships?|awarded scholarships? to study abroad|will spend (?:the summer|two months)|competitive pool|one of \d+ students selected|class of|['’]\d{2})\b/i.test(clean);
  const awardSignals = /\b(scholarship|fellowship|award|program|department of state)\b/i.test(clean);
  const personOrInstitutionSignals = /\b(student|senior|alumni|alumna|alumnus|university|college|school|cohort|finalist|recipient)\b/i.test(clean);

  return (
    (pressSignals && awardSignals && (recipientSignals || personOrInstitutionSignals)) ||
    (recipientSignals && awardSignals && personOrInstitutionSignals)
  );
}

function hasFormatOnlySnippetChange(before, after) {
  if (!before || !after) return false;
  const cleanBefore = normalizeComparableSnippet(before);
  const cleanAfter = normalizeComparableSnippet(after);
  if (!cleanBefore || !cleanAfter || cleanBefore === cleanAfter) return false;
  if (compactComparableSnippet(cleanBefore) === compactComparableSnippet(cleanAfter)) return true;
  if (!containsMonthDay(cleanBefore) || !containsMonthDay(cleanAfter)) return false;
  return normalizeDateFormattingSnippet(cleanBefore) === normalizeDateFormattingSnippet(cleanAfter);
}

function compactComparableSnippet(value) {
  return String(value || "").replace(/[^a-z0-9]+/g, "");
}

function normalizeDateFormattingSnippet(value) {
  const month = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  return String(value || "")
    .replace(new RegExp(`\\b(${month})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)\\b`, "gi"), "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/[.!?;:,\s]+$/g, "")
    .trim();
}

function containsMonthDay(value) {
  return /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(String(value || ""));
}

function hasUnsupportedStructuredFact(before, after, diff) {
  const evidenceText = [
    before,
    after,
    ...(diff.added_text || []),
    ...(diff.removed_text || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const amountFacts = (diff.amount_changes || []).flatMap(moneyFactPhrases);
  if (amountFacts.some((fact) => !evidenceText.includes(fact))) return true;

  return (diff.date_changes || [])
    .flatMap(dateFactPhrases)
    .some((fact) => !evidenceText.includes(fact));
}

function moneyFactPhrases(value) {
  return [...new Set(
    [...normalizeText(value).matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?\b/g)]
      .map((match) => normalizeText(match[0]).toLowerCase())
      .filter(Boolean),
  )];
}

function dateFactPhrases(value) {
  const clean = normalizeText(String(value || "").replace(/^(Added|Removed)\s+/i, ""));
  const month = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const monthYear = new RegExp("\\b(?:" + month + ")\\.?\\s+\\d{4}\\b", "gi");
  return [...new Set([...datePhrases(clean), ...[...clean.matchAll(monthYear)].map((match) => normalizeText(match[0]))])]
    .map((date) => date.toLowerCase())
    .filter(Boolean);
}

function hasContextOnlySnippetChange(beforeValue, afterValue, diff) {
  if (!beforeValue || !afterValue) return false;
  if (diff.date_changes?.length || diff.amount_changes?.length) return false;

  const pageType = cleanSlug(diff.page_type);
  if (/^(application|deadline|eligibility|requirements?)$/.test(pageType)) return false;

  const before = normalizeComparableSnippet(beforeValue);
  const after = normalizeComparableSnippet(afterValue);
  if (!before || !after || before === after) return false;

  const shorter = before.length <= after.length ? before : after;
  const longer = before.length > after.length ? before : after;
  if (shorter.length < 55 || !longer.includes(shorter)) return false;

  const extra = normalizeText(longer.replace(shorter, " "));
  if (extra.length < 24) return false;
  if (hasApplicationRequirementSignal(extra) || hasFundingAmountContext(extra)) return false;

  const sourceContext = String(diff.likely_section || "").toLowerCase();
  return (
    pageType === "other" ||
    pageType === "homepage" ||
    /\b(recognition|news|story|stories|events?|donors?|sponsors?|partners?|press|profiles?|past recipients?)\b/.test(sourceContext)
  );
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
    .map((sentence) => truncate(sentence, 360));
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
    before: dedupeText(beforeParts).join(" "),
    after,
  };
}

function firstTextMatch(text, patterns) {
  const clean = normalizeText(text || "");
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match?.[0]) return truncate(match[0], 260);
  }
  return null;
}

function dedupeText(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const clean = normalizeText(value);
    if (!clean) continue;
    const key = sentenceKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

function sentenceCandidates(text) {
  return splitChangeSentences(normalizeText(text)).map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 25 && sentence.length <= 520);
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
  return sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
  if (hasRawScrapeSignals(sentence)) return false;
  if (/\b(latest news|blog|story|press release|published|copyright|privacy|subscribe|newsletter)\b/.test(lower)) return false;
  if (isHistoricalRecipientOrMarketingText(sentence)) return false;
  return /\b(applications?|apply|deadline|due|opens?|closes?|eligible|eligibility|requirements?|recommendations?|transcripts?|essays?|interviews?|tuition|stipend|funding|fellows?|fellowship|scholarships?|awards?|admissions?|selection|nomination|candidates?|program|internship|grant|submit|submission|citizenship|gpa|pdf|guide|instructions?)\b/.test(lower);
}

function datePhrases(text) {
  const month = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const patterns = [new RegExp("\\b(?:" + month + ")\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?\\b", "gi"), /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, /\b\d{4}-\d{2}-\d{2}\b/g];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => cleanText(match[0])));
}

function contextualMoneyPhrases(text) {
  return [...new Set(
    [...text.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?\b/g)]
      .filter((match) => hasFundingAmountContext(contextAroundMatch(text, match.index || 0)))
      .map((match) => cleanText(match[0])),
  )];
}

function contextualDatePhrases(text) {
  return [...new Set(sentenceCandidates(text).filter(isAwardDateContext).flatMap(datePhrases))];
}

function contextAroundMatch(text, index) {
  return normalizeText(text.slice(Math.max(0, index - 180), index + 220));
}

function hasFundingAmountContext(value) {
  const lower = value.toLowerCase();
  if (/\b(cart|donate|donation|shop|store|subscribe|subscription|ticket|tickets|purchase|checkout|subtotal|merchandise|membership|sponsor|sponsorship)\b/.test(lower)) return false;
  return /\b(stipend|tuition|funding|funds?|grant|scholarships?|fellowships?|award amount|awards?:|amount awarded|prize|financial support|honorarium|living allowance|travel expenses?|research expenses?)\b/.test(lower);
}

function isAwardDateContext(sentence) {
  const lower = sentence.toLowerCase();
  if (isHistoricalRecipientOrMarketingText(sentence)) return false;
  return /\b(deadline|due|application|apply|opens?|closes?|timeline|round|eligible|eligibility|interview|selection|notification|acceptance|nomination|submit|submission)\b/.test(lower);
}

function inferSection(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(deadline|timeline|dates?)\b/.test(lower)) return "Dates and deadlines";
  if (/\b(eligible|eligibility|requirements?)\b/.test(lower)) return "Eligibility";
  if (/\b(apply|application|submit|submission)\b/.test(lower)) return "Application";
  if (/\b(recommendation|transcript|essay|materials?)\b/.test(lower)) return "Materials";
  if (/\b(funding|stipend|tuition|amount)\b/.test(lower)) return "Funding";
  return null;
}

function inferChangeType(diff, summary) {
  const haystack = [summary, ...diff.added_text, ...diff.removed_text, ...diff.date_changes, ...diff.amount_changes].join(" ").toLowerCase();
  if (diff.amount_changes.length || /\b(funding|stipend|tuition|fellowships? will be awarded|award amount|amount awarded)\b/.test(haystack)) return "funding";
  if (diff.date_changes.length || /\b(deadline|due|opens?|closes?|date)\b/.test(haystack)) return "deadline";
  if (/\b(eligible|eligibility|citizenship|gpa|enrolled)\b/.test(haystack)) return "eligibility";
  if (/\b(apply|application|submit|submission|recommendation|transcript|essay)\b/.test(haystack)) return "application";
  if (/\b(pdf|guide|handbook|instructions|document)\b/.test(haystack)) return "document";
  return diff.added_text.length ? "new_text" : diff.removed_text.length ? "removed_text" : "other";
}

function advisorImpact(changeType, diff) {
  if (changeType === "deadline") return "Check office timelines, reminders, and applicant instructions for this date.";
  if (changeType === "funding") return "Check award descriptions and applicant advising materials for this funding amount.";
  if (changeType === "eligibility") return "Review eligibility guidance before advising applicants from this award.";
  if (changeType === "application" || diff.added_text.length || diff.removed_text.length) return "Review applicant instructions for any needed office-facing updates.";
  return null;
}

function parseJsonObject(text) {
  const clean = normalizeText(String(text || "")).replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/i, "");
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

function extractGeminiText(data) {
  return (data.candidates || []).flatMap((candidate) => candidate.content?.parts || []).map((part) => part.text || "").join(" ").trim();
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text.trim();
  return (data.output || []).flatMap((item) => item.content || []).map((part) => part.text || "").join(" ").trim();
}

function resultRow(target, status, previousSummary, details) {
  return {
    kind: target.kind,
    id: target.row.id,
    detected_at: target.row.detected_at,
    status,
    previous_summary: previousSummary,
    reader_summary: details?.reader_summary || null,
    before: details?.before || null,
    after: details?.after || null,
    quality_flags: details?.quality_flags || [],
    generation_provider: details?.generation_provider || null,
    generation_status: details?.generation_status || null,
    generation_model: details?.generation_model || null,
  };
}

function selectAiProvider(value) {
  const requested = String(value || "auto").toLowerCase();
  if ((requested === "gemini" || requested === "auto") && env.GEMINI_API_KEY) return "gemini";
  if ((requested === "openai" || requested === "auto") && env.OPENAI_API_KEY) return "openai";
  return null;
}

function modelForProvider(provider) {
  if (provider === "gemini") return env.GEMINI_SUMMARY_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  if (provider === "openai") return env.OPENAI_SUMMARY_MODEL || env.OPENAI_DISCOVERY_MODEL || "gpt-4.1-mini";
  return null;
}

function withGenerationMetadata(details, provider, status, model) {
  return {
    ...details,
    generation_provider: provider,
    generation_status: status,
    generation_model: model,
  };
}

function changeDetailsResponseSchema() {
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

async function withRetry(label, fn) {
  let lastError = null;
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount) break;
      const delay = retryDelayMs * attempt;
      console.warn(label + " failed on attempt " + attempt + "; retrying in " + delay + "ms: " + errorMessage(error));
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
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

function loadTargetIdSet(idsArg, idsFileArg) {
  const ids = [];
  if (idsArg) {
    ids.push(...String(idsArg).split(","));
  }

  if (idsFileArg) {
    const raw = readFileSync(resolve(root, String(idsFileArg)), "utf8").trim();
    if (raw) {
      if (raw.startsWith("[")) {
        ids.push(...JSON.parse(raw));
      } else {
        ids.push(...raw.split(/\r?\n/));
      }
    }
  }

  const cleanIds = ids.map((id) => String(id).trim()).filter(Boolean);
  return cleanIds.length ? new Set(cleanIds) : null;
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
          const value = line.slice(index + 1).trim().replace(/^['\"]|['\"]$/g, "");
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

function addFlag(details, flag) {
  return { ...details, quality_flags: [...new Set([...(details.quality_flags || []), flag])] };
}

function cleanNullable(value) {
  const clean = cleanText(value);
  return clean || null;
}

function cleanSlug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function cleanText(value) {
  return normalizeText(String(value || "")).slice(0, 1200);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
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

function isHistoricalRecipientOrMarketingText(value) {
  return (
    /\b(past recipients?|recipient profiles?|latest news|press release|received the .* award|receives the .* award|photo by|getty images|new york, new york)\b/i.test(String(value || "")) ||
    looksLikeRecipientNewsOrPressText(value)
  );
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

function isVague(value) {
  const normalized = String(value || "").toLowerCase();
  return normalized.length < 28 || normalized.includes("page was updated") || normalized.includes("page has been updated") || normalized.includes("content was updated") || normalized.includes("something changed") || normalized.includes("added or expanded") || normalized.includes("no meaningful change") || normalized.includes("no award-relevant wording changed");
}

function truncate(value, maxLength) {
  const clean = normalizeText(value);
  if (clean.length <= maxLength) return clean;
  const truncated = clean.slice(0, maxLength + 1);
  const boundary = truncated.lastIndexOf(" ");
  return truncated.slice(0, boundary > maxLength * 0.65 ? boundary : maxLength).trim() + "...";
}
