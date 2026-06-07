#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as cheerio from "cheerio";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

const DIRECTORY_SITES = {
  ucla: {
    label: "UCLA GRAPES",
    url: "https://grad.ucla.edu/funding/",
  },
  uky: {
    label: "University of Kentucky Nationally Competitive Awards",
    url: "https://competitiveawards.uky.edu/awards",
  },
  usc: {
    label: "University of South Carolina National Fellowships",
    url: "https://sc.edu/about/offices_and_divisions/fellowships_and_scholar_programs/national_fellowships/competitions_and_deadlines/",
  },
};

const args = parseArgs(process.argv.slice(2));
const apply = Boolean(args.apply);
const sites = siteListArg(args.site || "all");
const limit = integerArg("limit", 0);
const concurrency = integerArg("concurrency", 6);
const timeoutMs = integerArg("timeout-ms", 25_000);
const nowLabel = new Date().toISOString().replace(/[:.]/g, "-");
const reportBase = join(root, "reports", `fellowship-directory-import-${nowLabel}`);

const nonOfficialExternalHosts = new Set([
  "facebook.com",
  "instagram.com",
  "informz.net",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "youtube.com",
]);

const discoveryHosts = new Set([
  "grad.ucla.edu",
  "competitiveawards.uky.edu",
  "sc.edu",
  "www.sc.edu",
  "fellowship-finder.grad.illinois.edu",
  "onsa.asu.edu",
]);

const campusHostDomains = new Set([
  "asu.edu",
  "illinois.edu",
  "uky.edu",
  "ucla.edu",
  "sc.edu",
]);

const stateNames = [
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "california",
  "colorado",
  "connecticut",
  "delaware",
  "florida",
  "georgia",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "new hampshire",
  "new jersey",
  "new mexico",
  "new york",
  "north carolina",
  "north dakota",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "rhode island",
  "south carolina",
  "south dakota",
  "tennessee",
  "texas",
  "utah",
  "vermont",
  "virginia",
  "washington",
  "west virginia",
  "wisconsin",
  "wyoming",
];

const existingCatalog = await loadExistingCatalog();
const rawCandidates = [];
const failures = [];

for (const site of sites) {
  try {
    if (site === "ucla") rawCandidates.push(...(await loadUclaCandidates()));
    if (site === "uky") rawCandidates.push(...(await loadUkyCandidates()));
    if (site === "usc") rawCandidates.push(...(await loadUscCandidates()));
  } catch (error) {
    failures.push({
      site,
      url: DIRECTORY_SITES[site]?.url || "",
      error: errorMessage(error),
    });
  }
}

const limitedCandidates = limit > 0 ? rawCandidates.slice(0, limit) : rawCandidates;
const processed = processCandidates(limitedCandidates, existingCatalog);
writeReports(processed, failures, limitedCandidates);

console.log(`Collected ${rawCandidates.length} directory entries from ${sites.join(", ")}.`);
console.log(
  [
    `Ready to import ${processed.newAwards.length} new awards`,
    `add ${processed.existingAwardSources.length} source URLs to existing awards`,
    `skip ${processed.exactDuplicateCount} exact/source duplicates`,
    `exclude ${processed.excluded.length} campus/state/non-official entries`,
    `review ${processed.review.length} uncertain entries`,
  ].join("; ") + ".",
);
console.log(`Report: ${reportBase}.json`);

if (!apply) {
  console.log("Dry run only. Re-run with --apply to write the high-confidence rows.");
  process.exit(failures.length ? 1 : 0);
}

const writeResult = await writeImportRows({
  newAwards: processed.newAwards,
  sources: [...processed.newAwardSources, ...processed.existingAwardSources],
});
console.log(JSON.stringify(writeResult, null, 2));

async function loadUclaCandidates() {
  const url = "https://grad.ucla.edu/se/grapes_details/select?q=*:*&rows=1000&wt=json";
  const payload = await fetchJson(url);
  const docs = payload?.response?.docs || [];
  return docs.map((doc) => {
    const originalName = cleanName(doc.awardtitle || "");
    const agency = cleanName(doc.agency1 || "");
    const name = displayNameWithAgency(originalName, agency);
    const summary = firstText(doc.description, doc.awardamountother, doc.requirements);
    const officialUrl = normalizeOfficialUrl(doc.WebSite || urlFromText(doc.contactinfo || ""));
    return {
      site: "ucla",
      directoryName: DIRECTORY_SITES.ucla.label,
      directoryUrl: DIRECTORY_SITES.ucla.url,
      detailUrl: `https://grad.ucla.edu/funding/#/view-record/${doc.recordno || doc.id || ""}`,
      name,
      alias: agency,
      summary,
      officialUrl,
      officialTitle: name,
      pageType: classifyPageType(officialUrl, "homepage"),
      rawText: [
        name,
        originalName,
        doc.agency1,
        doc.agency2,
        doc.awardtype,
        doc.description,
        doc.requirements,
        doc.citizenship,
        doc.tags?.join(" "),
      ]
        .filter(Boolean)
        .join(" "),
      flags: {
        uclaexclusive: Boolean(doc.uclaexclusive === true || doc.uclaexclusive === "true"),
      },
      confidence: 0.72,
    };
  });
}

async function loadUkyCandidates() {
  const listingUrls = await loadUkyListingUrls();
  const entries = [];
  for (const detailUrl of listingUrls) {
    entries.push(await loadUkyDetail(detailUrl));
  }
  return entries;
}

async function loadUkyListingUrls() {
  const firstHtml = await fetchHtml(DIRECTORY_SITES.uky.url);
  const $ = cheerio.load(firstHtml);
  let maxPage = 0;
  $("a[href*='?page=']").each((_index, element) => {
    const href = $(element).attr("href") || "";
    const page = Number(new URL(href, DIRECTORY_SITES.uky.url).searchParams.get("page") || "0");
    if (Number.isFinite(page)) maxPage = Math.max(maxPage, page);
  });

  const pageUrls = Array.from({ length: maxPage + 1 }, (_value, index) =>
    index === 0 ? DIRECTORY_SITES.uky.url : `${DIRECTORY_SITES.uky.url}?page=${index}`,
  );
  const pages = await mapWithConcurrency(pageUrls, concurrency, fetchHtml);
  const detailUrls = [];
  for (const html of pages) {
    const page = cheerio.load(html);
    page("a[href^='/awards/']").each((_index, element) => {
      const href = page(element).attr("href");
      if (href) detailUrls.push(new URL(href, DIRECTORY_SITES.uky.url).toString());
    });
  }
  return [...new Set(detailUrls)].sort();
}

async function loadUkyDetail(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const name = cleanName($("h1").first().text());
  const summary = firstText(
    $("meta[name='description']").attr("content"),
    $("main p").first().text(),
    $("article p").first().text(),
  );
  const official = officialLinkFromPage($, url, /fellowship website|award website|official website/i);
  return {
    site: "uky",
    directoryName: DIRECTORY_SITES.uky.label,
    directoryUrl: DIRECTORY_SITES.uky.url,
    detailUrl: url,
    name,
    alias: "",
    summary,
    officialUrl: official?.url || "",
    officialTitle: official?.title || name,
    pageType: classifyPageType(official?.url || "", official?.title || ""),
    rawText: normalizeText([name, summary].join(" ")),
    flags: {},
    confidence: 0.74,
  };
}

async function loadUscCandidates() {
  const html = await fetchHtml(DIRECTORY_SITES.usc.url);
  const $ = cheerio.load(html);
  const rows = [];
  $("a[href*='fellowship.php?fid=']").each((_index, element) => {
    const href = $(element).attr("href");
    const name = cleanName($(element).text());
    if (!href || !name || name.toLowerCase() === "competition details") return;
    const row = $(element).closest("tr");
    rows.push({
      detailUrl: new URL(href, DIRECTORY_SITES.usc.url).toString(),
      name,
      listingSummary: normalizeText(row.find("td").eq(1).text()).slice(0, 1200),
      alias: cleanName(row.find("td").eq(2).text()),
    });
  });

  const uniqueRows = [...dedupeBy(rows, (row) => row.detailUrl).values()];
  return mapWithConcurrency(uniqueRows, concurrency, loadUscDetail);
}

async function loadUscDetail(row) {
  const html = await fetchHtml(row.detailUrl);
  const $ = cheerio.load(html);
  const parsedName = cleanName($(".content-body h2, #mainContent h2")
    .filter((_index, element) => cleanName($(element).text()).toLowerCase() !== "competition details")
    .first()
    .text());
  const name = parsedName || row.name;
  const summary = firstText(
    sectionText($, "About this Fellowship"),
    row.listingSummary,
    $("meta[name='description']").attr("content"),
  );
  const official = officialLinkFromPage($, row.detailUrl, /fellowship website|award website|official website/i);
  const requirementsText = normalizeText($("table").first().text());
  return {
    site: "usc",
    directoryName: DIRECTORY_SITES.usc.label,
    directoryUrl: DIRECTORY_SITES.usc.url,
    detailUrl: row.detailUrl,
    name,
    alias: row.alias,
    summary,
    officialUrl: official?.url || "",
    officialTitle: official?.title || name,
    pageType: classifyPageType(official?.url || "", official?.title || ""),
    rawText: normalizeText([name, summary, requirementsText].join(" ")).slice(0, 8000),
    flags: {},
    confidence: 0.74,
  };
}

function processCandidates(candidates, catalog) {
  const importDedupe = new Map();
  const excluded = [];
  const review = [];
  const exactDuplicates = [];
  const newAwards = [];
  const newAwardSources = [];
  const existingAwardSources = [];

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    const exclusion = classifyExclusion(normalized);
    if (exclusion) {
      excluded.push({ ...normalized, status: "excluded", reason: exclusion });
      continue;
    }

    const duplicate = findDuplicate(normalized, catalog, importDedupe);
    if (duplicate?.kind === "exact-source") {
      exactDuplicates.push({ ...normalized, status: "duplicate", matchedAward: duplicate.award.name });
      continue;
    }

    if (duplicate?.kind === "existing-award") {
      const canonicalUrl = canonicalSourceUrlKey(normalized.officialUrl);
      if (!catalog.sourceUrlKeys.has(`${duplicate.award.id}\n${canonicalUrl}`)) {
        existingAwardSources.push(sourceRowForAward(normalized, duplicate.award.id, null));
      } else {
        exactDuplicates.push({ ...normalized, status: "duplicate", matchedAward: duplicate.award.name });
      }
      continue;
    }

    if (duplicate?.kind === "import-award") {
      const existing = importDedupe.get(duplicate.key);
      if (existing && normalized.officialUrl) {
        existing.provenance.push(provenance(normalized));
        existing.sources.push(sourceRowForAward(normalized, null, existing.searchKey));
      }
      continue;
    }

    if (normalized.quality < 0.67) {
      review.push({
        ...normalized,
        status: "needs_review",
        reason: "Low confidence after campus/state filtering.",
      });
      continue;
    }

    const searchKey = normalizeSharedAwardKey(normalized.name);
    const row = {
      searchKey,
      name: normalized.name,
      officialHomepage: normalized.officialUrl,
      summary: normalized.summary,
      confidence: normalized.quality,
      source: "admin",
      provenance: [provenance(normalized)],
      sources: [sourceRowForAward(normalized, null, searchKey)],
    };
    importDedupe.set(importDedupeKey(normalized), row);
  }

  for (const row of importDedupe.values()) {
    newAwards.push({
      searchKey: row.searchKey,
      name: row.name,
      officialHomepage: row.officialHomepage,
      summary: row.summary,
      confidence: row.confidence,
      source: row.source,
      provenance: row.provenance,
    });
    newAwardSources.push(...dedupeSources(row.sources));
  }

  return {
    newAwards,
    newAwardSources,
    existingAwardSources: dedupeSources(existingAwardSources),
    exactDuplicateCount: exactDuplicates.length,
    exactDuplicates,
    excluded,
    review,
  };
}

function normalizeCandidate(candidate) {
  const name = cleanName(candidate.name);
  const summary = truncate(firstText(candidate.summary), 700);
  const officialUrl = normalizeOfficialUrl(candidate.officialUrl);
  const officialTitle = cleanName(candidate.officialTitle || name);
  const rawText = normalizeText([candidate.rawText, name, summary].filter(Boolean).join(" "));
  let quality = candidate.confidence || 0.6;
  if (officialUrl) quality += 0.08;
  if (summary.length > 80) quality += 0.04;
  if (candidate.alias) quality += 0.02;
  quality = Math.min(0.9, quality);

  return {
    ...candidate,
    name,
    summary,
    officialUrl,
    officialTitle,
    pageType: classifyPageType(officialUrl, officialTitle),
    rawText,
    quality,
    looseKey: looseAwardKey(name),
    canonicalUrl: officialUrl ? canonicalSourceUrlKey(officialUrl) : "",
  };
}

function classifyExclusion(candidate) {
  if (!candidate.name) return "Missing award name.";
  if (!candidate.officialUrl) return "No official organization website was found.";
  if (!isLikelyOfficialSourceUrl(candidate.officialUrl)) return "Official URL is not trackable.";
  if (isGenericAwardName(candidate.name, candidate.alias)) {
    return "Generic directory title needs manual official-source naming.";
  }
  if (candidate.flags?.uclaexclusive) return "UCLA-exclusive campus funding.";

  const host = hostname(candidate.officialUrl);
  const fullOfficialUrl = candidate.officialUrl.toLowerCase();
  if (discoveryHosts.has(host)) return "Directory page is not an official organization website.";
  if (campusHostDomains.has(registrableDomain(host))) {
    return "Campus-hosted source page from a discovery institution.";
  }
  if (/(^|\.)calstate\.edu$/.test(host)) return "State university system award.";
  if (/(^|\.)scspacegrant\.cofc\.edu$/.test(host)) return "State-specific award source.";
  if (isCampusInstitutionHost(host)) return "Campus-hosted award source.";
  if (/\/(kentucky|south-carolina|california|campus-program)\b/i.test(fullOfficialUrl)) {
    return "State/campus-specific official URL.";
  }
  if (/kentuckysociety|esuus\.org\/kentucky|scwf\.org|sf\.gov|nycteachingfellows|lexingtonsistercities|ooe\.illinois\.gov|standrewsny/i.test(fullOfficialUrl)) {
    return "State/local award source.";
  }

  const lower = candidate.rawText.toLowerCase();
  const name = candidate.name.toLowerCase();
  if (/\b(ucla|university of california|uc berkeley|uc davis|uc irvine|uc merced|uc riverside|uc san diego|uc santa barbara|uc santa cruz|university of kentucky|uky|chellgren|university of south carolina|uofsc|south carolina honors college|palmetto college)\b/.test(lower)) {
    return "Campus-specific award or campus-only process.";
  }

  if (/\b(carolina scholars?|palmetto fellows?|horseshoe scholars?|1801 scholars?)\b/.test(lower)) {
    return "South Carolina campus/state scholarship.";
  }

  if (/\b(california|kentucky|south carolina|commonwealth)\b/.test(name)) {
    return "State-specific award name.";
  }
  if (/\b(city of|new york city|san francisco|lexington sister|state of [a-z ]+)\b/.test(name)) {
    return "State/local award name.";
  }

  if (/\bstate[- ](only|specific|wide)|\bin[- ]state\b|\bstate residents?\b|\bstate scholarship\b|\bstate fellowship\b/.test(lower)) {
    return "State-only eligibility language.";
  }

  for (const state of stateNames) {
    const residentPattern = new RegExp(`\\b${escapeRegExp(state)}\\s+residents?\\b|\\bresidents?\\s+of\\s+${escapeRegExp(state)}\\b`, "i");
    if (residentPattern.test(lower)) return "State residency eligibility.";
  }

  if (/\b(departmental|graduate division|internal funding|institutional grant|campus award|campus scholarship|campus fellowship)\b/.test(lower)) {
    return "Campus/internal funding language.";
  }

  return null;
}

function findDuplicate(candidate, catalog, importDedupe) {
  const exactKey = normalizeSharedAwardKey(candidate.name);
  const exactAward = catalog.awardsBySearchKey.get(exactKey);
  if (exactAward) return { kind: "existing-award", award: exactAward };

  if (candidate.canonicalUrl) {
    const sourceAward = catalog.awardByCanonicalSource.get(candidate.canonicalUrl);
    if (sourceAward) return { kind: "exact-source", award: sourceAward };
  }

  const loose = candidate.looseKey;
  const looseAward = loose ? catalog.awardsByLooseKey.get(loose) : null;
  if (looseAward) return { kind: "existing-award", award: looseAward };

  const key = importDedupeKey(candidate);
  if (importDedupe.has(key)) return { kind: "import-award", key };

  return null;
}

function sourceRowForAward(candidate, sharedAwardId, searchKey) {
  return {
    sharedAwardId,
    searchKey,
    url: candidate.officialUrl,
    title: candidate.officialTitle || candidate.name,
    pageType: candidate.pageType || "homepage",
    confidence: candidate.quality,
    reason: `Imported from ${candidate.directoryName}; directory detail: ${candidate.detailUrl}`,
    source: "admin",
    awardName: candidate.name,
  };
}

function provenance(candidate) {
  return {
    site: candidate.site,
    directoryName: candidate.directoryName,
    directoryUrl: candidate.directoryUrl,
    detailUrl: candidate.detailUrl,
    alias: candidate.alias || "",
  };
}

async function loadExistingCatalog() {
  const sql = `
select
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', shared_award.id,
        'name', shared_award.name,
        'searchKey', shared_award.search_key,
        'officialHomepage', shared_award.official_homepage,
        'sources', coalesce(source_rows.sources, '[]'::jsonb)
      )
      order by shared_award.name
    ),
    '[]'::jsonb
  ) as awards
from public.shared_awards shared_award
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'id', shared_source.id,
      'url', shared_source.url,
      'title', shared_source.title
    )
    order by shared_source.url
  ) as sources
  from public.shared_award_sources shared_source
  where shared_source.shared_award_id = shared_award.id
) source_rows on true
where shared_award.status = 'active';
`;
  const result = await runSupabaseQuery(sql);
  const awards = Array.isArray(result.rows?.[0]?.awards)
    ? result.rows[0].awards
    : JSON.parse(result.rows?.[0]?.awards || "[]");

  const awardsBySearchKey = new Map();
  const awardsByLooseKey = new Map();
  const awardByCanonicalSource = new Map();
  const sourceUrlKeys = new Set();

  for (const award of awards) {
    awardsBySearchKey.set(award.searchKey, award);
    const looseKey = looseAwardKey(award.name);
    if (looseKey && !awardsByLooseKey.has(looseKey)) awardsByLooseKey.set(looseKey, award);
    if (award.officialHomepage) {
      awardByCanonicalSource.set(canonicalSourceUrlKey(award.officialHomepage), award);
    }
    for (const source of award.sources || []) {
      const sourceKey = canonicalSourceUrlKey(source.url);
      sourceUrlKeys.add(`${award.id}\n${sourceKey}`);
      if (!awardByCanonicalSource.has(sourceKey)) awardByCanonicalSource.set(sourceKey, award);
    }
  }

  return {
    awards,
    awardsBySearchKey,
    awardsByLooseKey,
    awardByCanonicalSource,
    sourceUrlKeys,
  };
}

async function writeImportRows({ newAwards, sources }) {
  if (!newAwards.length && !sources.length) {
    return { rows: [{ award_rows_upserted: 0, source_rows_upserted: 0, homepage_rows_updated: 0 }] };
  }

  const awardPayload = JSON.stringify(newAwards);
  const sourcePayload = JSON.stringify(sources);
  const sql = `
with input_awards as (
  select *
  from jsonb_to_recordset(${sqlString(awardPayload)}::jsonb) as row(
    "searchKey" text,
    name text,
    "officialHomepage" text,
    summary text,
    confidence numeric,
    source text
  )
),
award_upserts as (
  insert into public.shared_awards (
    search_key,
    name,
    official_homepage,
    summary,
    confidence,
    status,
    source
  )
  select
    "searchKey",
    name,
    "officialHomepage",
    summary,
    confidence,
    'active',
    source
  from input_awards
  on conflict (search_key) do update set
    official_homepage = coalesce(public.shared_awards.official_homepage, excluded.official_homepage),
    summary = coalesce(public.shared_awards.summary, excluded.summary),
    confidence = greatest(public.shared_awards.confidence, excluded.confidence),
    updated_at = now()
  returning id, search_key
),
input_sources as (
  select *
  from jsonb_to_recordset(${sqlString(sourcePayload)}::jsonb) as row(
    "sharedAwardId" uuid,
    "searchKey" text,
    url text,
    title text,
    "pageType" text,
    confidence numeric,
    reason text,
    source text
  )
),
matched_awards as (
  select shared_awards.id, shared_awards.search_key
  from public.shared_awards
  where shared_awards.search_key in (
    select "searchKey" from input_sources where "searchKey" is not null
  )
  union
  select id, search_key from award_upserts
),
resolved_sources as (
  select
    coalesce(input_sources."sharedAwardId", matched_awards.id) as shared_award_id,
    input_sources.url,
    input_sources.title,
    input_sources."pageType",
    input_sources.confidence,
    input_sources.reason,
    input_sources.source
  from input_sources
  left join matched_awards
    on matched_awards.search_key = input_sources."searchKey"
  where coalesce(input_sources."sharedAwardId", matched_awards.id) is not null
    and input_sources.url is not null
    and input_sources.url <> ''
),
source_upserts as (
  insert into public.shared_award_sources (
    shared_award_id,
    url,
    title,
    page_type,
    confidence,
    reason,
    source
  )
  select
    shared_award_id,
    url,
    title,
    "pageType",
    confidence,
    reason,
    source
  from resolved_sources
  on conflict (shared_award_id, url) do update set
    title = excluded.title,
    page_type = excluded.page_type,
    confidence = greatest(public.shared_award_sources.confidence, excluded.confidence),
    reason = excluded.reason,
    source = case
      when public.shared_award_sources.source = 'admin' then public.shared_award_sources.source
      else excluded.source
    end,
    updated_at = now()
  returning shared_award_id, url, page_type, confidence
),
best_homepages as (
  select distinct on (shared_award_id)
    shared_award_id,
    url
  from resolved_sources
  order by
    shared_award_id,
    case when "pageType" = 'homepage' then 0 else 1 end,
    confidence desc,
    length(url) asc
),
homepage_updates as (
  update public.shared_awards shared_award
  set official_homepage = best_homepages.url,
      updated_at = now()
  from best_homepages
  where shared_award.id = best_homepages.shared_award_id
    and (shared_award.official_homepage is null or shared_award.official_homepage = '')
  returning shared_award.id
)
select
  (select count(*) from award_upserts) as award_rows_upserted,
  (select count(*) from source_upserts) as source_rows_upserted,
  (select count(*) from homepage_updates) as homepage_rows_updated;
`;
  return runSupabaseQuery(sql);
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: requestHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: requestHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function requestHeaders() {
  return {
    "user-agent": "AwardPingDirectoryImporter/1.0 (+https://awardping.com)",
    accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  };
}

function officialLinkFromPage($, baseUrl, textPattern) {
  const candidates = [];
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    const title = cleanName($(element).text() || $(element).attr("aria-label") || "");
    if (!href) return;
    try {
      const url = new URL(href, baseUrl);
      url.hash = "";
      if (!["http:", "https:"].includes(url.protocol)) return;
      if (!textPattern.test(title) && !isLikelyOfficialExternalLink(url, title, baseUrl)) return;
      if (!isLikelyOfficialSourceUrl(url.toString())) return;
      candidates.push({ url: url.toString(), title: title || "Official website" });
    } catch {
      // Ignore malformed links.
    }
  });

  return candidates.sort((left, right) => linkScore(right) - linkScore(left))[0] || null;
}

function isLikelyOfficialExternalLink(url, title, baseUrl) {
  const parsedBase = new URL(baseUrl);
  const baseHost = parsedBase.hostname.toLowerCase().replace(/^www\./, "");
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === baseHost) return false;
  if (discoveryHosts.has(host)) return false;
  if (nonOfficialExternalHosts.has(registrableDomain(host))) return false;
  const lower = `${title} ${url.toString()}`.toLowerCase();
  if (/\b(map|locations?|jobs|jobregister|directory|contact|privacy|terms|accessibility|emergency|wp-login)\b/.test(lower)) {
    return false;
  }
  return /website|official|fellow|scholar|award|program|apply|application|foundation|association|institute/.test(lower);
}

function isLikelyOfficialSourceUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (nonOfficialExternalHosts.has(registrableDomain(host))) return false;
    if (discoveryHosts.has(host)) return false;
    const lower = url.toString().toLowerCase();
    if (/[?&](share|replytocom|utm_|fbclid|gclid|redirect_to=)/.test(lower)) return false;
    if (/\/(wp-login\.php|login|signin|sign-in|cart|donate|privacy|terms|terms-of-use|terms-of-service|jobregister)\b/.test(lower)) {
      return false;
    }
    if (/\.(jpg|jpeg|png|gif|webp|svg|zip|ics|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/i.test(url.pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isCampusInstitutionHost(host) {
  const campusDomains = [
    "aucegypt.edu",
    "brown.edu",
    "case.edu",
    "clemson.edu",
    "colorado.edu",
    "columbia.edu",
    "cornell.edu",
    "harvard.edu",
    "iup.edu",
    "kyoto-u.ac.jp",
    "mayo.edu",
    "msstate.edu",
    "olemiss.edu",
    "purdue.edu",
    "sandiego.edu",
    "uab.edu",
    "umd.edu",
    "umich.edu",
    "unmc.edu",
    "wm.edu",
    "yale.edu",
  ];
  return campusDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function classifyPageType(url, title) {
  if (!url) return "homepage";
  const lower = `${url} ${title}`.toLowerCase();
  try {
    if (new URL(url).pathname.toLowerCase().endsWith(".pdf")) return "pdf";
  } catch {
    return "homepage";
  }
  if (/(deadline|dates?|timeline|cycle)/.test(lower)) return "deadline";
  if (/(apply|application|portal|nomination|references?|recommendation|advice|guidance)/.test(lower)) return "application";
  if (/(eligib|who-can-apply)/.test(lower)) return "eligibility";
  if (/(requirement|criteria|materials|documents)/.test(lower)) return "requirements";
  if (/(faq|questions)/.test(lower)) return "faq";
  return "homepage";
}

function linkScore(link) {
  const lower = `${link.title} ${link.url}`.toLowerCase();
  let score = 0;
  if (/fellowship website|award website|official website/.test(lower)) score += 10;
  if (/fellow|scholar|award|grant/.test(lower)) score += 4;
  if (/apply|application/.test(lower)) score += 2;
  if (/\.pdf\b/.test(lower)) score -= 3;
  return score;
}

function sectionText($, headingText) {
  const heading = $("h1,h2,h3,h4").filter((_index, element) =>
    normalizeText($(element).text()).toLowerCase().includes(headingText.toLowerCase()),
  ).first();
  if (!heading.length) return "";
  const parts = [];
  let next = heading.next();
  while (next.length && !/^h[1-4]$/i.test(next.prop("tagName") || "")) {
    const text = normalizeText(next.text());
    if (text) parts.push(text);
    next = next.next();
  }
  return parts.join(" ");
}

function normalizeOfficialUrl(value) {
  const raw = urlFromText(value || "");
  if (!raw) return "";
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return "";
  }
}

function urlFromText(value) {
  const text = String(value || "").replace(/<[^>]+>/g, " ");
  const match = text.match(/https?:\/\/[^\s<>"')]+|(?:www\.)[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"')]+)?/i);
  return match ? match[0].replace(/[.,;]+$/g, "") : "";
}

function cleanName(value) {
  return normalizeText(value)
    .replace(/\s+\|\s+.+$/g, "")
    .replace(/^The\s+/i, "")
    .trim();
}

function displayNameWithAgency(name, agency) {
  if (!agency || !isGenericTitle(name)) return name;
  const normalizedAgency = agency.replace(/\s+\(.+?\)\s*$/g, "").trim();
  if (!normalizedAgency) return name;
  if (name.toLowerCase().includes(normalizedAgency.toLowerCase())) return name;
  return `${normalizedAgency} ${name}`;
}

function isGenericAwardName(name, alias) {
  if (!isGenericTitle(name)) return false;
  return !alias || looseAwardKey(alias).length < 7;
}

function isGenericTitle(name) {
  const normalized = normalizeSharedAwardKey(name);
  return /^(fellowships?|scholarships?|grants?|research grants?|travel grants?|internships?|summer internships?|student internship program|college internships?|doctoral program|postdoctoral fellowships?|postdoctoral fellow|postdoctoral research associateships?|postdoctoral scholar program|graduate student research grants?|graduate research assistant program|minority scholarship program|residential fellowships?|society fellowships?|field research fellowship|career development program)$/.test(normalized);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function firstText(...values) {
  return values.map(normalizeText).find(Boolean) || "";
}

function truncate(value, max) {
  const text = normalizeText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trim()}...`;
}

function normalizeSharedAwardKey(name) {
  const key = cleanName(name).toLowerCase().replace(/\s+/g, " ");
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

function looseAwardKey(name) {
  const text = normalizeSharedAwardKey(name)
    .replace(/&/g, " and ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|and|of|for|in|to|with|a|an|programs?|scholarships?|fellowships?|awards?|grants?|foundation|fund|competition|initiative)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length >= 7 ? text : "";
}

function canonicalSourceUrlKey(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname
      .replace(/\/index\.(html?|php|aspx?)$/i, "/")
      .replace(/\/+$/g, "")
      .toLowerCase();
    const searchParams = [...url.searchParams.entries()]
      .filter(([key, val]) => {
        const lowerKey = key.toLowerCase();
        if (!val || lowerKey.startsWith("utm_")) return false;
        return !["fbclid", "gclid", "msclkid", "mc_cid", "mc_eid", "share", "replytocom"].includes(lowerKey);
      })
      .map(([key, val]) => [key.toLowerCase(), val.toLowerCase()])
      .sort(([left], [right]) => left.localeCompare(right));
    const search = searchParams.length
      ? `?${searchParams.map(([key, val]) => `${key}=${val}`).join("&")}`
      : "";
    return `${host}${pathname || "/"}${search}`;
  } catch {
    return String(value || "").trim().toLowerCase().replace(/\/+$/g, "");
  }
}

function hostname(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function registrableDomain(host) {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

function importDedupeKey(candidate) {
  return candidate.looseKey || normalizeSharedAwardKey(candidate.name) || candidate.canonicalUrl;
}

function dedupeSources(sources) {
  return [...dedupeBy(sources, (source) => `${source.sharedAwardId || source.searchKey}\n${canonicalSourceUrlKey(source.url)}`).values()];
}

function dedupeBy(values, keyFn) {
  const map = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!map.has(key)) map.set(key, value);
  }
  return map;
}

async function mapWithConcurrency(values, workerCount, callback) {
  const results = new Array(values.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, workerCount) }, async () => {
    while (index < values.length) {
      const current = index;
      index += 1;
      try {
        results[current] = await callback(values[current], current);
      } catch (error) {
        failures.push({
          site: "fetch",
          url: typeof values[current] === "string" ? values[current] : values[current]?.detailUrl || "",
          error: errorMessage(error),
        });
        results[current] = null;
      }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

function writeReports(processed, failuresForReport, candidates) {
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    apply,
    sites,
    directoryUrls: Object.fromEntries(sites.map((site) => [site, DIRECTORY_SITES[site].url])),
    counts: {
      candidates: candidates.length,
      newAwards: processed.newAwards.length,
      newAwardSources: processed.newAwardSources.length,
      existingAwardSources: processed.existingAwardSources.length,
      exactDuplicates: processed.exactDuplicateCount,
      excluded: processed.excluded.length,
      review: processed.review.length,
      failures: failuresForReport.length,
    },
    newAwards: processed.newAwards,
    newAwardSources: processed.newAwardSources,
    existingAwardSources: processed.existingAwardSources,
    exactDuplicates: processed.exactDuplicates,
    excluded: processed.excluded,
    review: processed.review,
    failures: failuresForReport,
  };

  writeFileSync(`${reportBase}.json`, JSON.stringify(report, null, 2), "utf8");

  const csvRows = [
    ["status", "site", "name", "official_url", "detail_url", "reason"],
    ...processed.newAwards.map((award) => [
      "new_award",
      award.provenance[0]?.site || "",
      award.name,
      award.officialHomepage,
      award.provenance[0]?.detailUrl || "",
      "",
    ]),
    ...processed.existingAwardSources.map((source) => [
      "existing_award_new_source",
      "",
      source.awardName,
      source.url,
      source.reason.replace(/^Imported from .*; directory detail: /, ""),
      "",
    ]),
    ...processed.excluded.map((entry) => [
      "excluded",
      entry.site,
      entry.name,
      entry.officialUrl,
      entry.detailUrl,
      entry.reason,
    ]),
    ...processed.review.map((entry) => [
      "needs_review",
      entry.site,
      entry.name,
      entry.officialUrl,
      entry.detailUrl,
      entry.reason,
    ]),
    ...failuresForReport.map((entry) => [
      "failed_fetch",
      entry.site,
      "",
      "",
      entry.url,
      entry.error,
    ]),
  ];
  writeFileSync(`${reportBase}.csv`, csvRows.map(csvLine).join("\n"), "utf8");
}

function csvLine(row) {
  return row.map((cell) => `"${String(cell || "").replaceAll('"', '""')}"`).join(",");
}

async function runSupabaseQuery(sql) {
  const dir = join(tmpdir(), `awardping-directory-query-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "query.sql");
  writeFileSync(file, sql, "utf8");
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["supabase@latest", "db", "query", "--linked", "--output", "json", "--file", file],
      {
        cwd: root,
        maxBuffer: 80 * 1024 * 1024,
      },
    );
    return parseSupabaseJson(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseSupabaseJson(stdout) {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) throw new Error(`Supabase CLI did not return JSON: ${stdout}`);
  return JSON.parse(stdout.slice(jsonStart));
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [rawKey, inlineValue] = value.slice(2).split("=");
    if (inlineValue !== undefined) {
      addArg(parsed, rawKey, inlineValue);
      continue;
    }

    const nextValue = values[index + 1];
    if (nextValue && !nextValue.startsWith("--")) {
      addArg(parsed, rawKey, nextValue);
      index += 1;
    } else {
      addArg(parsed, rawKey, true);
    }
  }
  return parsed;
}

function addArg(parsed, key, value) {
  if (parsed[key] === undefined) {
    parsed[key] = value;
    return;
  }
  if (!Array.isArray(parsed[key])) parsed[key] = [parsed[key]];
  parsed[key].push(value);
}

function siteListArg(value) {
  const values = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const selected = values.includes("all") ? Object.keys(DIRECTORY_SITES) : values;
  const invalid = selected.filter((site) => !DIRECTORY_SITES[site]);
  if (invalid.length) throw new Error(`Unknown site(s): ${invalid.join(", ")}`);
  return selected;
}

function integerArg(name, fallback) {
  const value = Number(args[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
