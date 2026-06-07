#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as cheerio from "cheerio";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

const args = parseArgs(process.argv.slice(2));
const limit = integerArg("limit", 100);
const maxPerAward = integerArg("max-per-award", 3);
const concurrency = integerArg("concurrency", 3);
const timeoutMs = integerArg("timeout-ms", 15_000);
const dryRun = Boolean(args["dry-run"]);
const renderMode = String(args.render || "auto");
const hostFilter = stringListArg("host");

const institutionalDiscoveryHosts = new Set([
  "fellowship-finder.grad.illinois.edu",
  "onsa.asu.edu",
]);
const phoneNumberPathSegment = /(?:^|\/)\+?(?:\d[\d().-]*){9,}(?:\/|$)/;

const nonOfficialExternalHosts = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "paypal.com",
  "twitter.com",
  "x.com",
  "youtube.com",
]);

let browserPromise = null;

const awards = await loadDiscoveryAwards();
console.log(`Loaded ${awards.length} awards with discovery-only source pages.`);

const stats = {
  awardsChecked: 0,
  awardsWithCandidates: 0,
  candidates: 0,
  failed: 0,
};
const upsertRows = [];

await mapWithConcurrency(awards, concurrency, async (award) => {
  stats.awardsChecked += 1;
  try {
    const candidates = await findAwardCandidates(award);
    if (candidates.length) {
      stats.awardsWithCandidates += 1;
      stats.candidates += candidates.length;
      upsertRows.push(...candidates);
      console.log(
        `FOUND ${String(candidates.length).padStart(2, " ")} | ${award.award_name}`,
      );
      for (const candidate of candidates) {
        console.log(`  - ${candidate.pageType.padEnd(12, " ")} ${candidate.url}`);
      }
    } else {
      console.log(`MISS       | ${award.award_name}`);
    }
  } catch (error) {
    stats.failed += 1;
    console.log(`FAILED     | ${award.award_name} | ${errorMessage(error)}`);
  }
});

await closeBrowser();

const dedupedRows = [...dedupeRows(upsertRows).values()];
console.log(
  `Finished discovery: ${stats.awardsWithCandidates}/${stats.awardsChecked} awards produced ${dedupedRows.length} deduped source rows; ${stats.failed} failed.`,
);

if (dryRun) {
  console.log("Dry run only. No database rows were written.");
  process.exit(0);
}

if (!dedupedRows.length) {
  console.log("No official source candidates found to write.");
  process.exit(0);
}

const writeResult = await writeDiscoveredSources(dedupedRows);
console.log(JSON.stringify(writeResult, null, 2));

async function loadDiscoveryAwards() {
  const allowedHosts = hostFilter.length
    ? hostFilter.filter((host) => institutionalDiscoveryHosts.has(host))
    : [...institutionalDiscoveryHosts];
  if (!allowedHosts.length) {
    throw new Error(`No valid discovery hosts were requested.`);
  }

  const sql = `
with source_counts as (
  select
    shared_award.id,
    count(shared_source.id) filter (
      where replace(lower(split_part(split_part(shared_source.url, '/', 3), ':', 1)), 'www.', '')
        not in ('fellowship-finder.grad.illinois.edu', 'onsa.asu.edu')
    ) as official_source_count
  from public.shared_awards shared_award
  left join public.shared_award_sources shared_source
    on shared_source.shared_award_id = shared_award.id
  where shared_award.status = 'active'
  group by shared_award.id
),
discovery_sources as (
  select
    shared_award.id as shared_award_id,
    shared_award.name as award_name,
    jsonb_agg(
      jsonb_build_object(
        'id', shared_source.id,
        'url', shared_source.url,
        'title', shared_source.title
      )
      order by
        case
          when shared_source.url ~ '/[0-9]+/?$' then 0
          when shared_source.url like '%/scholarship/%' then 0
          else 1
        end,
        length(shared_source.url) desc
    ) as sources
  from public.shared_awards shared_award
  join source_counts source_count
    on source_count.id = shared_award.id
  join public.shared_award_sources shared_source
    on shared_source.shared_award_id = shared_award.id
  where source_count.official_source_count = 0
    and replace(lower(split_part(split_part(shared_source.url, '/', 3), ':', 1)), 'www.', '')
      in (${allowedHosts.map(sqlString).join(", ")})
  group by shared_award.id, shared_award.name
)
select *
from discovery_sources
order by award_name
limit ${limit};
`;

  const result = await runSupabaseQuery(sql);
  return result.rows.map((row) => ({
    ...row,
    sources: Array.isArray(row.sources) ? row.sources : JSON.parse(row.sources || "[]"),
  }));
}

async function findAwardCandidates(award) {
  const allLinks = [];
  for (const source of award.sources || []) {
    if (!source?.url || source.title === "Back To Search") continue;

    const url = new URL(source.url);
    let links = await fetchStaticLinks(url);
    const needsRendering =
      links.length === 0 &&
      renderMode !== "never" &&
      url.hostname.toLowerCase().replace(/^www\./, "") ===
        "fellowship-finder.grad.illinois.edu";

    if (needsRendering) {
      links = await fetchRenderedLinks(url, award.award_name);
    }

    allLinks.push(...links);
  }

  const parentSource = {
    url: award.sources?.find((source) => source?.url && source.title !== "Back To Search")?.url,
    title: award.award_name,
    shared_awards: { name: award.award_name },
  };

  return rankLinks(parentSource, allLinks)
    .filter((candidate) => isTrackableOfficialSourceUrl(candidate.url))
    .slice(0, maxPerAward)
    .map((candidate) => ({
      sharedAwardId: award.shared_award_id,
      awardName: award.award_name,
      url: candidate.url,
      title: cleanTitle(candidate.title, candidate.url),
      pageType: candidate.pageType,
      confidence: candidate.confidence,
      reason: `Discovered from ${sourceLabelForReason(award.sources)}.`,
      source: "admin",
    }));
}

async function fetchStaticLinks(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "AwardPingSourceDiscovery/1.0 (+https://awardping.com)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Fetch failed with HTTP ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    return [];
  }

  return extractLinks(await response.text(), url);
}

async function fetchRenderedLinks(url, awardName) {
  const browser = await getBrowser();
  if (!browser) return [];

  const page = await browser.newPage();
  try {
    await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page
      .waitForFunction(
        (expectedAwardName) => {
          const body = document.body?.innerText || "";
          return body.includes(expectedAwardName) && !body.includes("Loading...");
        },
        awardName,
        { timeout: timeoutMs },
      )
      .catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => null);
    return extractLinks(await page.content(), url);
  } finally {
    await page.close().catch(() => null);
  }
}

async function getBrowser() {
  if (renderMode === "never") return null;
  if (!browserPromise) {
    browserPromise = (async () => {
      try {
        const { chromium } = await importPlaywright();
        return chromium.launch({ headless: true });
      } catch (error) {
        if (renderMode === "always") {
          throw new Error(
            `Playwright is required for rendered discovery pages: ${errorMessage(error)}`,
          );
        }
        return null;
      }
    })();
  }

  const browser = await browserPromise;
  if (!browser && renderMode === "always") {
    throw new Error("Playwright is required for rendered discovery pages.");
  }

  return browser;
}

async function importPlaywright() {
  try {
    return await import("playwright");
  } catch (localError) {
    try {
      const globalRoot = execFileSync("npm", ["root", "-g"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const imported = await import(pathToFileURL(join(globalRoot, "playwright", "index.js")).href);
      return imported.chromium ? imported : imported.default;
    } catch {
      throw localError;
    }
  }
}

async function closeBrowser() {
  const browser = browserPromise ? await browserPromise.catch(() => null) : null;
  await browser?.close().catch(() => null);
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

function rankLinks(source, links) {
  if (!source.url) return [];

  const awardName = source.shared_awards?.name || source.title;
  const sourceUrl = new URL(source.url);
  const sourceDirectory = directoryPath(sourceUrl.pathname);
  const sourceIsInstitutionalDiscovery = isInstitutionalDiscoveryUrl(source.url);
  const awardTokens = tokens(awardName).filter(
    (token) =>
      ![
        "award",
        "awards",
        "fellowship",
        "fellowships",
        "scholarship",
        "scholarships",
        "program",
      ].includes(token),
  );

  return links
    .map((link) => {
      const linkUrl = new URL(link.url);
      const lower = `${link.url} ${link.title}`.toLowerCase();
      const pageType = classifyPageType(link.url, link.title);
      const sameProgramArea =
        sourceDirectory !== "/" && linkUrl.pathname.toLowerCase().startsWith(sourceDirectory);
      const relatedSubdomain =
        linkUrl.hostname !== sourceUrl.hostname && isRelatedHost(linkUrl.hostname, sourceUrl.hostname);
      const officialExternalFromInstitution =
        sourceIsInstitutionalDiscovery && isLikelyOfficialExternalLink(linkUrl, link.title, sourceUrl);
      let score = pageType === "other" ? 0 : 5;
      if (sameProgramArea) score += 4;
      if (relatedSubdomain) score += 3;
      if (officialExternalFromInstitution) score += 8;
      for (const token of awardTokens) {
        if (lower.includes(token)) score += 2;
      }
      if (/\b(about|overview|information|official|website|sponsor)\b/.test(lower)) score += 2;
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
        confidence: Math.min(0.88, 0.45 + score / 20),
      };
    })
    .filter((link) => link.score >= 4)
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length);
}

async function writeDiscoveredSources(rows) {
  const payload = JSON.stringify(rows);
  const sql = `
with input_rows as (
  select *
  from jsonb_to_recordset(${sqlString(payload)}::jsonb) as row(
    "sharedAwardId" uuid,
    "awardName" text,
    url text,
    title text,
    "pageType" text,
    confidence numeric,
    reason text,
    source text
  )
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
    input_rows."sharedAwardId",
    input_rows.url,
    input_rows.title,
    input_rows."pageType",
    input_rows.confidence,
    input_rows.reason,
    input_rows.source
  from input_rows
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
  returning id
),
best_homepages as (
  select distinct on ("sharedAwardId")
    "sharedAwardId",
    url
  from input_rows
  order by
    "sharedAwardId",
    case when "pageType" = 'homepage' then 0 else 1 end,
    confidence desc,
    length(url) asc
),
homepage_updates as (
  update public.shared_awards shared_award
  set official_homepage = best_homepages.url,
      updated_at = now()
  from best_homepages
  where shared_award.id = best_homepages."sharedAwardId"
    and (
      shared_award.official_homepage is null
      or shared_award.official_homepage = ''
      or replace(lower(split_part(split_part(shared_award.official_homepage, '/', 3), ':', 1)), 'www.', '')
        in ('fellowship-finder.grad.illinois.edu', 'onsa.asu.edu')
    )
  returning shared_award.id
)
select
  (select count(*) from input_rows) as input_rows,
  (select count(*) from source_upserts) as source_rows_upserted,
  (select count(*) from homepage_updates) as homepage_rows_updated;
`;

  return runSupabaseQuery(sql);
}

async function runSupabaseQuery(sql) {
  const dir = mkdtempSync(join(tmpdir(), "awardping-source-query-"));
  const file = join(dir, "query.sql");
  writeFileSync(file, sql, "utf8");
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["supabase@latest", "db", "query", "--linked", "--output", "json", "--file", file],
      {
        cwd: root,
        maxBuffer: 50 * 1024 * 1024,
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

function isInstitutionalDiscoveryUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return institutionalDiscoveryHosts.has(hostname);
  } catch {
    return false;
  }
}

function isTrackableOfficialSourceUrl(value) {
  if (!value || isInstitutionalDiscoveryUrl(value)) return false;
  try {
    return !isExcludedUrl(new URL(value));
  } catch {
    return false;
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

  return title.trim().length > 0 || /scholar|fellow|award|program|apply|application/.test(lower);
}

function isExcludedUrl(url) {
  const lower = url.toString().toLowerCase();
  const awardRelated = /(scholar|fellow|award|grant|program|apply|application|deadline|eligib)/.test(lower);
  return (
    !["http:", "https:"].includes(url.protocol) ||
    phoneNumberPathSegment.test(decodeURIComponent(url.pathname)) ||
    /\/(wp-login\.php|login|signin|sign-in|register|cart|donate|privacy|terms|terms-of-use|terms-of-service|termsofuse|jobregister)\b/.test(lower) ||
    /\/(sign-up|signup|subscribe|newsletter)\b/.test(lower) ||
    /\/portal\/user\/u_login\.php/.test(lower) ||
    (!awardRelated && /\/(news|events|calendar|tag|category)\b/.test(lower)) ||
    /[?&](share|replytocom|utm_|fbclid|gclid|redirect_to=)/.test(lower) ||
    /\.(jpg|jpeg|png|gif|webp|svg|zip|ics|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/i.test(url.pathname)
  );
}

function normalizeUrlKey(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\.aspx$/i, "");
  return parsed.toString().replace(/\/$/, "").toLowerCase();
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function cleanTitle(title, url) {
  const trimmed = normalizeText(title);
  if (trimmed && trimmed.length <= 180) return trimmed;
  if (trimmed) return `${trimmed.slice(0, 177)}...`;
  return new URL(url).hostname.replace(/^www\./, "");
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
  const baseDomain = registrableDomain(normalizedBase);
  return (
    normalizedHost === normalizedBase ||
    normalizedHost === baseDomain ||
    normalizedHost.endsWith(`.${baseDomain}`)
  );
}

function registrableDomain(hostname) {
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

function sourceLabelForReason(sources) {
  const first = sources?.find((source) => source?.url && source.title !== "Back To Search");
  if (!first?.url) return "an institutional award discovery page";
  return first.url;
}

function dedupeRows(rows) {
  const deduped = new Map();
  for (const row of rows) {
    const key = `${row.sharedAwardId}\n${normalizeUrlKey(row.url)}`;
    const existing = deduped.get(key);
    if (!existing || row.confidence > existing.confidence) {
      deduped.set(key, row);
    }
  }
  return deduped;
}

async function mapWithConcurrency(values, workerCount, callback) {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, workerCount) }, async () => {
    while (index < values.length) {
      const value = values[index];
      index += 1;
      await callback(value);
    }
  });
  await Promise.all(workers);
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

function integerArg(name, fallback) {
  const value = Number(args[name] ?? fallback);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function stringListArg(name) {
  const value = args[name];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
