#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";
import { classifySourceHygiene } from "./source-hygiene.mjs";
import { classifySourceForConsolidation } from "./source-consolidation-core.mjs";
import {
  canonicalSourceUrlKey,
  csvEscape,
  findDuplicateLoserIds,
} from "./source-cleanup-core.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = {
  ...loadEnvFile(envPath),
  ...process.env,
};

const apply = boolArg(args.apply, false);
const moveReviewLater = boolArg(args["move-review-later"], true);
const cleanupTitles = boolArg(args["cleanup-titles"], false);
const addMissingHomepages = boolArg(args["add-missing-homepages"], true);
const safetyMode = String(args.safety || "safe").trim().toLowerCase();
const batchSize = positiveInt(args["batch-size"], 200);
const titleConcurrency = positiveInt(args["title-concurrency"], 8);
const outputPrefix =
  args["output-prefix"] ||
  join(root, "reports", `full-source-cleanup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const jsonPath = `${outputPrefix}.json`;
const csvPath = `${outputPrefix}.csv`;
const awardPhraseCache = new Map();

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createSupabaseServiceClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
);

console.log(
  `Full source cleanup; apply=${apply}; safety=${safetyMode}; moveReviewLater=${moveReviewLater}; cleanupTitles=${cleanupTitles}; addMissingHomepages=${addMissingHomepages}.`,
);

const [awards, loadedSources] = await Promise.all([
  loadActiveAwards(),
  loadActiveAwardSources(),
]);

const awardsById = new Map(awards.map((award) => [award.id, award]));
const activeAwardIds = new Set(awards.map((award) => award.id));
const allSources = dedupeById(loadedSources).filter((source) => activeAwardIds.has(source.shared_award_id));
const openSources = allSources.filter((source) => source.admin_review_status === "open");
const duplicateLoserIds = findDuplicateLoserIds(openSources);
const now = new Date().toISOString();

const allCleanupCandidates = [];
const keepSources = [];

for (const source of openSources) {
  const award = awardsById.get(source.shared_award_id) || null;
  const decision = cleanupDecision(source, award, duplicateLoserIds);
  if (decision.action === "review_later") {
    allCleanupCandidates.push({ source, award, ...decision });
  } else {
    keepSources.push(source);
  }
}

const cleanupCandidates =
  safetyMode === "full"
    ? allCleanupCandidates
    : allCleanupCandidates.filter((row) => isSafeAutomaticCleanup(row));
const manualCleanupCandidates = allCleanupCandidates.filter(
  (row) => !cleanupCandidates.some((candidate) => candidate.source.id === row.source.id),
);
const cleanupSourceIds = new Set(cleanupCandidates.map((row) => row.source.id));
const keepSourceIds = new Set(openSources.filter((source) => !cleanupSourceIds.has(source.id)).map((source) => source.id));
const titleCandidates = cleanupTitles
  ? openSources
      .filter((source) => keepSourceIds.has(source.id))
      .map((source) => titleCleanupDecision(source, awardsById.get(source.shared_award_id) || null))
      .filter(Boolean)
  : [];

const homepageCandidates = addMissingHomepages
  ? missingHomepageRows({ awards, allSources, reviewLaterSourceIds: new Set(cleanupCandidates.map((row) => row.source.id)) })
  : [];

const summary = {
  generated_at: now,
  apply,
  safety_mode: safetyMode,
  active_awards: awards.length,
  active_sources_total: allSources.length,
  active_open_sources: openSources.length,
  review_later_candidates: cleanupCandidates.length,
  manual_review_candidates: manualCleanupCandidates.length,
  cleanup_candidates_total: allCleanupCandidates.length,
  title_update_candidates: titleCandidates.length,
  missing_homepage_candidates: homepageCandidates.length,
  review_later_by_reason: countBy(cleanupCandidates, (row) => row.reason),
  manual_review_by_reason: countBy(manualCleanupCandidates, (row) => row.reason),
  title_updates_by_reason: countBy(titleCandidates, (row) => row.reason),
  missing_homepages_by_award_sample: homepageCandidates.slice(0, 60).map((row) => ({
    award_id: row.shared_award_id,
    award_name: awardsById.get(row.shared_award_id)?.name || "",
    url: row.url,
  })),
  review_later_sample: cleanupCandidates.slice(0, 100).map(serializeCleanupRow),
  manual_review_sample: manualCleanupCandidates.slice(0, 100).map(serializeCleanupRow),
  title_update_sample: titleCandidates.slice(0, 100).map(serializeTitleRow),
};

mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");
writeFileSync(
  csvPath,
  renderCleanupCsv(cleanupCandidates, manualCleanupCandidates, titleCandidates, homepageCandidates, awardsById),
  "utf8",
);

console.log(JSON.stringify(summaryForConsole(summary), null, 2));

let reviewLaterUpdated = 0;
let titleUpdated = 0;
let homepageInserted = 0;

if (apply) {
  if (moveReviewLater && cleanupCandidates.length) {
    reviewLaterUpdated = await markReviewLater(cleanupCandidates, now);
  }

  if (cleanupTitles && titleCandidates.length) {
    titleUpdated = await updateDisplayTitles(titleCandidates, now, titleConcurrency);
  }

  if (addMissingHomepages && homepageCandidates.length) {
    homepageInserted = await upsertHomepageSources(homepageCandidates);
  }
}

const afterOpenCount = apply ? await countOpenSources() : null;
const result = {
  apply,
  report_json: jsonPath,
  report_csv: csvPath,
  marked_review_later: reviewLaterUpdated,
  updated_display_titles: titleUpdated,
  upserted_homepage_sources: homepageInserted,
  active_open_sources_after: afterOpenCount,
};

console.log(JSON.stringify(result, null, 2));

function cleanupDecision(source, award, duplicateLoserIdsForOpenSources) {
  if (duplicateLoserIdsForOpenSources.has(source.id)) {
    return {
      action: "review_later",
      reason: "duplicate_source",
      note: "Duplicate canonical source URL for the same award.",
      classifier: "duplicate",
    };
  }

  const sourceForHygiene = {
    ...source,
    display_title: null,
    award_name: award?.name || "",
  };
  const hygiene = classifySourceHygiene(sourceForHygiene, {});
  if (hygiene.action === "review_later") {
    return {
      action: "review_later",
      reason: hygiene.reason,
      note: hygiene.note,
      classifier: "hygiene",
    };
  }

  const consolidation = classifySourceForConsolidation({ ...source, display_title: null }, award || {});
  if (consolidation.action === "review_later") {
    return {
      action: "review_later",
      reason: consolidation.reason,
      note: consolidation.note,
      classifier: "consolidation",
      qualityScore: consolidation.qualityScore,
      signals: consolidation.signals,
    };
  }

  return { action: "keep", reason: null, note: null, classifier: null };
}

function isSafeAutomaticCleanup(row) {
  const safeReasons = new Set([
    "duplicate_source",
    "software_download",
    "social_or_share_link",
    "media_or_archive_file",
    "recursive_or_cyclic_url",
    "duplicate_pdf_export",
    "boilerplate_or_policy_link",
    "generic_navigation_source",
    "agency_policy_spillover",
    "legislative_archive_spillover",
    "archive_pdf_spillover",
    "professional_training_spillover",
    "professional_material_spillover",
    "same_host_sibling_program_spillover",
    "broad_grants_listing_spillover",
    "campus_program_spillover",
    "product_resource_spillover",
    "agency_foia_spillover",
    "governance_pdf_spillover",
    "commercial_sample_spillover",
    "participant_report_spillover",
    "nspires_roses_spillover",
    "academic_policy_pdf_spillover",
    "broad_scholarship_brochure",
    "broad_directory_spillover",
    "agency_program_spillover",
    "library_service_spillover",
    "educational_resource_spillover",
  ]);

  if (safeReasons.has(row.reason)) return true;
  if (row.reason === "generic_source_shape") return isSafeGenericSourceShape(row.source, row.award);
  return false;
}

function isSafeGenericSourceShape(source, award) {
  const url = safeUrl(source.url);
  if (!url) return true;

  const path = url.pathname.toLowerCase();
  if (/\/(?:search|search-results?|site-search|search-results-page)(?:\/|\.html?|\.aspx?|$)/.test(path)) {
    return true;
  }
  if (/\/(?:guidelinesearch|sitesearch|search|searchresults?)\.(?:html?|aspx?|php)$/.test(path)) {
    return true;
  }
  if (hasGenericSearchQuery(url)) return true;

  if (/\/(?:tag|tags|category|categories)(?:\/|$)/.test(path)) {
    const signal = `${source.title || ""} ${source.url || ""}`;
    return !hasAnyDistinctiveAwardToken(signal, award?.name || "");
  }

  return false;
}

function hasGenericSearchQuery(url) {
  const path = url.pathname.toLowerCase().replace(/\/+$/g, "") || "/";
  for (const [rawKey, rawValue] of url.searchParams.entries()) {
    const key = rawKey.toLowerCase();
    const value = String(rawValue || "").trim();
    if (!value) continue;
    if (["search", "keyword", "keywords", "keys", "search_api_fulltext"].includes(key)) return true;
    if (key === "q" && (path === "/" || /\/(?:search|site-search|search-results?)$/.test(path))) return true;
    if (key === "s" && (path === "/" || path === "/index.php")) return true;
    if (key === "query") return true;
  }
  return false;
}

function hasAnyDistinctiveAwardToken(signal, awardName) {
  const normalizedSignal = cleanText(signal).toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return distinctiveAwardTokens(awardName).some((token) =>
    new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(normalizedSignal),
  );
}

function distinctiveAwardTokens(value) {
  const generic = new Set([
    "administration",
    "american",
    "academic",
    "association",
    "award",
    "awards",
    "college",
    "department",
    "doctoral",
    "earth",
    "exchange",
    "foundation",
    "fellow",
    "fellowship",
    "fellowships",
    "graduate",
    "grant",
    "grants",
    "institute",
    "international",
    "national",
    "postdoctoral",
    "program",
    "programs",
    "research",
    "scholar",
    "scholars",
    "scholarship",
    "scholarships",
    "science",
    "sciences",
    "service",
    "student",
    "students",
    "technology",
    "university",
  ]);

  return [
    ...new Set(
      cleanText(value)
        .toLowerCase()
        .replace(/&/g, " and ")
        .split(/[^a-z0-9]+/g)
        .filter((token) => token.length >= 4 && !generic.has(token)),
    ),
  ].slice(0, 12);
}

function titleCleanupDecision(source, award) {
  const nextTitle = conciseSourceDisplayTitle(source, award);
  if (!nextTitle) return null;

  const currentDisplay = cleanText(source.display_title);
  const currentReadable = cleanText(currentDisplay || source.title);
  if (sameTitle(currentDisplay, nextTitle) || sameTitle(currentReadable, nextTitle)) {
    return null;
  }

  const rawTitle = cleanText(source.title);
  const shouldUpdate =
    !currentDisplay ||
    currentDisplay.length > 56 ||
    rawTitle.length > 72 ||
    includesAwardPhrase(currentDisplay || rawTitle, award?.name || "") ||
    /^https?:\/\//i.test(currentDisplay || rawTitle) ||
    looksLikeUrlPathTitle(currentDisplay || rawTitle);

  if (!shouldUpdate) return null;
  if (nextTitle.length > 80 || isWeakTitle(nextTitle)) return null;

  return {
    source,
    award,
    current_display_title: source.display_title || null,
    current_title: source.title || null,
    next_display_title: nextTitle,
    reason: currentDisplay ? "simplify_display_title" : "add_display_title",
  };
}

function conciseSourceDisplayTitle(source, award) {
  const awardName = cleanText(award?.name);
  const rawTitle = readableSourceTitle(source.display_title || source.title, source.url);
  const storedTitle = readableSourceTitle(source.title, source.url);
  const isOfficialHomepage =
    Boolean(award?.official_homepage) &&
    normalizeUrl(source.url) === normalizeUrl(award.official_homepage);

  if (
    (source.page_type === "homepage" || isOfficialHomepage) &&
    (!rawTitle || /^(homepage|home|source page|official homepage|official page)$/i.test(rawTitle))
  ) {
    return "Homepage";
  }

  if (source.page_type === "homepage" || isOfficialHomepage || sameTitle(rawTitle, awardName)) {
    return "Homepage";
  }

  const shortened = shortenSourceDisplayTitle(rawTitle, awardName);
  if (shortened) return shortened;

  const shortenedStoredTitle = shortenSourceDisplayTitle(storedTitle, awardName);
  if (shortenedStoredTitle) return shortenedStoredTitle;

  if (source.display_title && storedTitle && !isWeakTitle(storedTitle) && !looksLikeUrlPathTitle(storedTitle)) {
    return storedTitle;
  }

  const fromUrl = readableSourceTitle(null, source.url);
  if (isWeakTitle(rawTitle) && fromUrl && !isWeakTitle(fromUrl)) return fromUrl;

  return rawTitle || "Source page";
}

function missingHomepageRows({ awards, allSources, reviewLaterSourceIds }) {
  const allKeysByAward = new Map();
  const openKeysByAward = new Map();
  const reviewedKeysByAward = new Map();

  for (const source of allSources) {
    const key = canonicalSourceUrlKey(source.url);
    addToSetMap(allKeysByAward, source.shared_award_id, key);
    if (source.admin_review_status === "open" && !reviewLaterSourceIds.has(source.id)) {
      addToSetMap(openKeysByAward, source.shared_award_id, key);
    }
    if (source.admin_review_status === "review_later" || reviewLaterSourceIds.has(source.id)) {
      addToSetMap(reviewedKeysByAward, source.shared_award_id, key);
    }
  }

  return awards
    .filter((award) => isTrackableHomepage(award.official_homepage))
    .filter((award) => {
      const key = canonicalSourceUrlKey(award.official_homepage);
      if (openKeysByAward.get(award.id)?.has(key)) return false;
      if (reviewedKeysByAward.get(award.id)?.has(key)) return false;
      return !allKeysByAward.get(award.id)?.has(key);
    })
    .map((award) => ({
      shared_award_id: award.id,
      url: award.official_homepage,
      title: "Homepage",
      display_title: "Homepage",
      page_type: "homepage",
      confidence: 0.7,
      reason: "Full source cleanup pass added the award's official homepage as a monitorable source.",
      source: "admin",
      admin_review_status: "open",
    }));
}

async function markReviewLater(rows, reviewedAt) {
  let updated = 0;
  const groups = groupBy(rows, (row) => `${row.reason || "cleanup"}\n${row.classifier || "cleanup"}`);

  for (const values of groups.values()) {
    const first = values[0];
    const update = {
      admin_review_status: "review_later",
      admin_review_note: `Full source cleanup pass: ${first.reason}. ${first.note || "Source is not useful for the public award outline."}`,
      admin_reviewed_at: reviewedAt,
      admin_reviewed_by: "awardping-full-source-cleanup",
      updated_at: reviewedAt,
    };

    for (const batch of chunk(values, batchSize)) {
      const ids = batch.map((row) => row.source.id);
      const { error } = await supabase.from("shared_award_sources").update(update).in("id", ids);
      if (error) throw new Error(`review_later update failed: ${error.message}`);
      updated += ids.length;
      console.log(`MARKED review_later ${updated}/${rows.length}`);
    }
  }

  return updated;
}

async function updateDisplayTitles(rows, updatedAt, concurrency) {
  let updated = 0;
  for (let index = 0; index < rows.length; index += concurrency) {
    const batch = rows.slice(index, index + concurrency);
    await Promise.all(
      batch.map(async (row) => {
        const { error } = await supabase
          .from("shared_award_sources")
          .update({
            display_title: row.next_display_title,
            updated_at: updatedAt,
          })
          .eq("id", row.source.id);
        if (error) throw new Error(`display_title update failed for ${row.source.id}: ${error.message}`);
        updated += 1;
      }),
    );
    if (updated % 100 === 0 || updated === rows.length) {
      console.log(`UPDATED display_title ${updated}/${rows.length}`);
    }
  }
  return updated;
}

async function upsertHomepageSources(rows) {
  let upserted = 0;
  for (const batch of chunk(rows, batchSize)) {
    const { error } = await supabase
      .from("shared_award_sources")
      .upsert(batch, { onConflict: "shared_award_id,url" });
    if (error) throw new Error(`homepage source upsert failed: ${error.message}`);
    upserted += batch.length;
    console.log(`UPSERTED homepage sources ${upserted}/${rows.length}`);
  }
  return upserted;
}

async function loadActiveAwards() {
  return loadPaged(() =>
    supabase
      .from("shared_awards")
      .select("id,name,slug,official_homepage,status")
      .eq("status", "active")
      .order("name", { ascending: true }),
  );
}

async function loadActiveAwardSources() {
  return loadPaged(() =>
    supabase
      .from("shared_award_sources")
      .select(
        "id,shared_award_id,url,title,display_title,page_description,page_metadata,page_type,confidence,reason,source,last_error,last_checked_at,consecutive_failures,admin_review_status,created_at,updated_at",
      )
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  );
}

async function countOpenSources() {
  const { count, error } = await supabase
    .from("shared_award_sources")
    .select("id", { count: "exact", head: true })
    .eq("admin_review_status", "open");
  if (error) throw new Error(`open source count failed: ${error.message}`);
  return count || 0;
}

async function loadPaged(makeQuery) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(`Supabase load failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function renderCleanupCsv(cleanupRows, manualRows, titleRows, homepageRows, awardsById) {
  const headers = [
    "kind",
    "reason",
    "award_name",
    "source_title",
    "display_title",
    "next_display_title",
    "page_type",
    "url",
    "note",
  ];

  const rows = [
    ...cleanupRows.map((row) => [
      "review_later",
      row.reason,
      row.award?.name || "",
      row.source.title || "",
      row.source.display_title || "",
      "",
      row.source.page_type || "",
      row.source.url || "",
      row.note || "",
    ]),
    ...manualRows.map((row) => [
      "manual_review_cleanup",
      row.reason,
      row.award?.name || "",
      row.source.title || "",
      row.source.display_title || "",
      "",
      row.source.page_type || "",
      row.source.url || "",
      row.note || "",
    ]),
    ...titleRows.map((row) => [
      "title_update",
      row.reason,
      row.award?.name || "",
      row.current_title || "",
      row.current_display_title || "",
      row.next_display_title || "",
      row.source.page_type || "",
      row.source.url || "",
      "",
    ]),
    ...homepageRows.map((row) => [
      "missing_homepage",
      "add_missing_homepage_source",
      awardsById.get(row.shared_award_id)?.name || "",
      row.title || "",
      row.display_title || "",
      "",
      row.page_type || "",
      row.url || "",
      row.reason || "",
    ]),
  ];

  return `${[headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function serializeCleanupRow(row) {
  return {
    award_id: row.award?.id || row.source.shared_award_id,
    award_name: row.award?.name || "",
    source_id: row.source.id,
    title: row.source.title,
    display_title: row.source.display_title,
    page_type: row.source.page_type,
    url: row.source.url,
    reason: row.reason,
    classifier: row.classifier,
    note: row.note,
  };
}

function serializeTitleRow(row) {
  return {
    award_id: row.award?.id || row.source.shared_award_id,
    award_name: row.award?.name || "",
    source_id: row.source.id,
    title: row.current_title,
    display_title: row.current_display_title,
    next_display_title: row.next_display_title,
    page_type: row.source.page_type,
    url: row.source.url,
    reason: row.reason,
  };
}

function summaryForConsole(summary) {
  return {
    generated_at: summary.generated_at,
    apply: summary.apply,
    safety_mode: summary.safety_mode,
    active_awards: summary.active_awards,
    active_open_sources: summary.active_open_sources,
    review_later_candidates: summary.review_later_candidates,
    manual_review_candidates: summary.manual_review_candidates,
    cleanup_candidates_total: summary.cleanup_candidates_total,
    title_update_candidates: summary.title_update_candidates,
    missing_homepage_candidates: summary.missing_homepage_candidates,
    review_later_by_reason: summary.review_later_by_reason,
    manual_review_by_reason: summary.manual_review_by_reason,
    title_updates_by_reason: summary.title_updates_by_reason,
    report_json: jsonPath,
    report_csv: csvPath,
  };
}

function shortenSourceDisplayTitle(title, awardName) {
  const original = cleanText(title);
  const hadDownloadSuffix = /\s*(?:\[(?:download|pdf)\]|\((?:download|pdf)\))\s*$/i.test(original);
  let value = original
    .replace(/\s*\[(?:download|pdf)\]\s*$/i, "")
    .replace(/\s*\((?:download|pdf)\)\s*$/i, "")
    .replace(/^(?:the\s+)?national academies(?: of sciences, engineering, and medicine)?\s+/i, "")
    .replace(/\bapplicant resources?\b/gi, "")
    .trim();

  if (!value) return "";

  const cleanedOriginal = value;
  value = bestNonBrandSegment(value, awardName);
  for (const phrase of removableAwardPhrases(awardName)) {
    value = removePhrase(value, phrase);
  }

  value = bestNonBrandSegment(value, awardName)
    .replace(/^(?:official\s+)?(?:award|awards)\s+committee\s+/i, "")
    .replace(/^(?:official\s+)?(?:award|awards|scholarship|scholarships|fellowship|fellowships|grant|grants|program|programme)\s*[:|/-]?\s*/i, "")
    .replace(/^(?:official\s+)?(?:award|awards)\s+/i, "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s:|/-]+|[\s:|/-]+$/g, "")
    .trim();

  if (isDanglingShortTitle(value)) return "";
  if (!value || (!hadDownloadSuffix && sameTitle(value, cleanedOriginal))) return "";
  return toDisplayTitleCase(value);
}

function bestNonBrandSegment(title, awardName) {
  const parts = cleanText(title)
    .split(/\s*(?:[|:]|-)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return cleanText(title);

  const awardPhrases = removableAwardPhrases(awardName);
  const hasBrandPart = parts.some((part) => awardPhrases.some((phrase) => phraseMatches(part, phrase)));
  if (!hasBrandPart) return cleanText(title);

  const nonBrand = parts.find((part) => !awardPhrases.some((phrase) => phraseMatches(part, phrase)));
  return nonBrand || parts[0];
}

function removableAwardPhrases(awardName) {
  const cleanAwardName = cleanText(awardName);
  if (awardPhraseCache.has(cleanAwardName)) return awardPhraseCache.get(cleanAwardName);
  const withoutParentheticals = cleanAwardName.replace(/\([^)]*\)/g, " ");
  const acronyms = [...cleanAwardName.matchAll(/\(([A-Z][A-Z0-9&]{1,})\)/g)].map((match) => match[1]);
  const pieces = cleanAwardName
    .split(/\s*(?:[|:]|-)\s+/)
    .flatMap((part) => [part, part.replace(/\([^)]*\)/g, " ")]);
  const subphrases = awardSubphrases(withoutParentheticals);
  const phrases = [cleanAwardName, withoutParentheticals, ...pieces, ...subphrases, ...acronyms]
    .flatMap(awardPhraseVariants)
    .map((phrase) => phrase.replace(/\s+/g, " ").trim())
    .filter((phrase, index, phrases) => phrase.length >= 2 && phrases.indexOf(phrase) === index)
    .sort((a, b) => b.length - a.length);
  awardPhraseCache.set(cleanAwardName, phrases);
  return phrases;
}

function awardSubphrases(value) {
  const words = cleanText(value).split(/\s+/).filter(Boolean);
  const phrases = [];
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 3; end <= words.length; end += 1) {
      const phrase = words.slice(start, end).join(" ");
      if (/\b(award|scholarships?|fellowships?|grants?|programs?|programme)\b/i.test(phrase)) {
        phrases.push(phrase);
      }
    }
  }
  return phrases;
}

function awardPhraseVariants(value) {
  const variants = new Set([value]);
  variants.add(value.replace(/\bfellowship\b/gi, "Fellowships"));
  variants.add(value.replace(/\bfellowships\b/gi, "Fellowship"));
  variants.add(value.replace(/\bscholarship\b/gi, "Scholarships"));
  variants.add(value.replace(/\bscholarships\b/gi, "Scholarship"));
  variants.add(value.replace(/\bprogram\b/gi, "Programs"));
  variants.add(value.replace(/\bprograms\b/gi, "Program"));
  variants.add(value.replace(/\bprogramme\b/gi, "Programmes"));
  variants.add(value.replace(/\bprogrammes\b/gi, "Programme"));
  return [...variants];
}

function removePhrase(value, phrase) {
  if (!phrase) return value;
  const escaped = escapeRegExp(phrase);
  return cleanText(value)
    .replace(new RegExp(`^(\\d{4}(?:-\\d{2,4})?\\s+)${escaped}\\b\\s*[:|/-]?\\s*`, "i"), "$1")
    .replace(new RegExp(`^${escaped}\\b\\s*[:|/-]?\\s*`, "i"), "")
    .replace(new RegExp(`\\s*[:|/-]?\\s*\\b${escaped}$`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();
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

  const url = safeUrl(sourceUrl);
  return url ? readableTitleFromUrl(url) : "Source page";
}

function readableTitleFromUrl(url) {
  const segments = meaningfulUrlSegments(url);
  const segment = segments.at(-1);
  if (!segment) return "Homepage";

  if (/^application-tips-/i.test(segment)) {
    return `${formatPathSegment(segment.replace(/^application-tips-/i, ""))} Application Tips`;
  }

  if (/^(apply|application)$/i.test(segment)) {
    const context = segments.slice(0, -1).at(-1);
    return context ? `${formatPathSegment(context)} Application` : "Application Page";
  }

  if (/^(tips|tips-here)$/i.test(segment)) {
    const context = segments.slice(0, -1).at(-1);
    return context ? `${formatPathSegment(context)} Tips` : "Tips";
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
        !/^index\.(html?|php|aspx?)$/i.test(segment) &&
        !/^(page|pages|resources?|view|programs?|awards?|scholarships?|fellowships?|grants?)$/i.test(segment),
    );
}

function cleanDisplayText(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/([.!?])(?=[A-Z0-9])/g, "$1 ")
    .replace(/\s*;\s*/g, "; ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPathSegment(segment) {
  const decoded = safeDecodeURIComponent(segment).replace(/\.(html?|php|aspx?|pdf)$/i, "");
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

function toDisplayTitleCase(value) {
  const clean = cleanText(value);
  if (!clean) return "";

  const smallWords = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "nor", "of", "on", "or", "the", "to", "with"]);
  return clean
    .split(" ")
    .map((word, index, words) => {
      const normalized = word.toLowerCase();
      if (/^[A-Z0-9&]{2,}$/.test(word)) return word;
      if (index > 0 && index < words.length - 1 && smallWords.has(normalized)) return normalized;
      return word
        .split(/([/-])/)
        .map((part) => {
          if (/^[/-]$/.test(part)) return part;
          if (/^[A-Z0-9&]{2,}$/.test(part)) return part;
          if (/^faqs?$/i.test(part)) return part.toLowerCase() === "faqs" ? "FAQs" : "FAQ";
          const lower = part.toLowerCase();
          return lower ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : part;
        })
        .join("");
    })
    .join(" ");
}

function isTrackableHomepage(value) {
  const url = safeUrl(value);
  if (!url) return false;
  if (!["http:", "https:"].includes(url.protocol)) return false;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.toLowerCase().replace(/\/+$/g, "") || "/";
  if (host === "fellowship-finder.grad.illinois.edu" || host === "onsa.asu.edu") return false;
  if (host === "get.adobe.com") return false;
  if (host === "www8.nationalacademies.org" && /^\/pa\/(?:managerequest|feedback)\.aspx$/.test(path)) return false;
  if (host === "nationalacademies.org" && (path === "/" || /^\/(?:current-operating-status|members|myacademies-accounts|advancing-a-robust-us-economy|projects)(?:\/|$)/.test(path))) {
    return false;
  }
  if (/\/(?:login|signin|sign-in|cart|donate|privacy|terms|subscribe|newsletter)(?:\/|$)/i.test(path)) return false;
  return true;
}

function includesAwardPhrase(value, awardName) {
  const clean = cleanText(value);
  return removableAwardPhrases(awardName).some((phrase) => phrase.length >= 4 && phraseMatches(clean, phrase));
}

function phraseMatches(value, phrase) {
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i").test(value);
}

function isGenericActionTitle(value) {
  return /^(apply|applications?|learn more|read more|view more|more information|details?|click here|here|tips here\.?)$/i.test(
    cleanText(value),
  );
}

function isWeakTitle(value) {
  return /^(source page|other source|homepage|home|download|details?|information|read more|learn more|click here|here)$/i.test(
    cleanText(value),
  );
}

function isDanglingShortTitle(value) {
  const clean = cleanText(value).replace(/[\u2013\u2014]/g, "-").replace(/[\s-]+$/g, "").trim();
  return (
    /^(about|about the|apply|the)$/i.test(clean) ||
    /\b(?:for|of|and|or|the)\s*$/i.test(clean)
  );
}

function looksLikeUrlPathTitle(value) {
  const clean = cleanText(value);
  return (
    /^\/+$/.test(clean) ||
    /^\/[^/]+(?:\/[^/]+)*\/?$/i.test(clean) ||
    /^[a-z0-9-]+(?:\/[a-z0-9-]+)+\/?$/i.test(clean)
  );
}

function sameTitle(left, right) {
  return normalizeTitleKey(left) === normalizeTitleKey(right);
}

function normalizeTitleKey(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeUrl(value) {
  const url = safeUrl(value);
  if (!url) return cleanText(value).toLowerCase();
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
  return url.toString().toLowerCase();
}

function addToSetMap(map, key, value) {
  const set = map.get(key) || new Set();
  set.add(value);
  map.set(key, set);
}

function groupBy(values, getKey) {
  const groups = new Map();
  for (const value of values) {
    const key = getKey(value);
    groups.set(key, [...(groups.get(key) || []), value]);
  }
  return groups;
}

function countBy(values, getKey) {
  const counts = {};
  for (const value of values) {
    const key = getKey(value) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function dedupeById(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

function safeUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
  }
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [rawKey, inlineValue] = value.slice(2).split("=");
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
      continue;
    }
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[rawKey] = next;
      index += 1;
    } else {
      parsed[rawKey] = true;
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
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
