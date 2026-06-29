#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as cheerio from "cheerio";
import { chromium } from "playwright-core";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";
import { csvEscape } from "./source-cleanup-core.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const apply = boolArg(args.apply, false);
const applyNonStale = boolArg(args["apply-non-stale"], false);
const deactivateStale = boolArg(args["deactivate-stale"], false);
const awardIdFilter = stringArg(args["award-id"]);
const hostFilter = stringArg(args.host);
const limit = positiveInt(args.limit, awardIdFilter ? 1 : 50);
const timeoutMs = positiveInt(args["timeout-ms"], 35_000);
const renderDelayMs = positiveInt(args["render-delay-ms"], 4_000);
const outputPath =
  args.output ||
  join(root, "reports", `listing-opportunity-reconciliation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const reviewCsvPath =
  args["review-output"] ||
  join(root, "reports", `listing-opportunity-reconciliation-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);

const supabase = createSupabaseClient();
const awards = await loadAll(
  "shared_awards",
  "id,search_key,name,slug,official_homepage,summary,confidence,status,source,updated_at",
);
const sources = await loadAll(
  "shared_award_sources",
  "id,shared_award_id,url,title,page_type,confidence,reason,source,last_error,last_checked_at,created_at",
);
const activeAwardsById = new Map(
  awards.filter((award) => award.status === "active").map((award) => [award.id, award]),
);
const existingAwardsByKey = new Map(awards.map((award) => [award.search_key, award]));
const existingAwardsBySlug = new Map(
  awards.filter((award) => award.slug).map((award) => [award.slug, award]),
);
const existingAwardsByHomepage = new Map(
  awards.filter((award) => award.official_homepage).map((award) => [canonicalUrlKey(award.official_homepage), award]),
);
const existingSourceKeys = new Set(
  sources.map((source) => `${source.shared_award_id}\n${canonicalUrlKey(source.url)}`),
);

const targets = sources
  .filter((source) => {
    const award = activeAwardsById.get(source.shared_award_id);
    if (!award) return false;
    if (awardIdFilter && award.id !== awardIdFilter) return false;
    if (hostFilter && hostName(source.url) !== normalizeHost(hostFilter)) return false;
    return isListingSource(source);
  })
  .sort((left, right) => {
    const leftAward = activeAwardsById.get(left.shared_award_id)?.name || "";
    const rightAward = activeAwardsById.get(right.shared_award_id)?.name || "";
    return leftAward.localeCompare(rightAward) || left.url.localeCompare(right.url);
  })
  .slice(0, limit);

console.log(
  `Reconciling ${targets.length} listing-like source pages; apply=${apply}; applyNonStale=${applyNonStale}; deactivateStale=${deactivateStale}.`,
);

let browser = null;
const results = [];
const rowsToReview = [];
const stats = {
  targets: targets.length,
  pagesRead: 0,
  pagesFailed: 0,
  opportunitiesFound: 0,
  awardsUpserted: 0,
  sourceRowsUpserted: 0,
  staleAwardsFlagged: 0,
  staleAwardsArchived: 0,
};

try {
  for (const source of targets) {
    const award = activeAwardsById.get(source.shared_award_id);
    if (!award) continue;

    try {
      const pageData = await readListingPage(source.url);
      stats.pagesRead += 1;
      const opportunities = extractOpportunities(pageData, source, award);
      const stale = isStaleListingAward(award, pageData, opportunities);
      stats.opportunitiesFound += opportunities.length;
      if (stale) stats.staleAwardsFlagged += 1;

      const result = {
        awardId: award.id,
        awardName: award.name,
        sourceId: source.id,
        sourceUrl: source.url,
        finalUrl: pageData.url,
        pageTitle: pageData.title,
        status: stale ? "stale_listing" : opportunities.length ? "opportunities_found" : "no_opportunities",
        stale,
        opportunities,
        applied: false,
      };

      if (apply && opportunities.length && (stale || applyNonStale)) {
        for (const opportunity of opportunities) {
          const upsert = await upsertOpportunityAward(opportunity, source, award);
          if (upsert.awardChanged) stats.awardsUpserted += 1;
          if (upsert.sourceChanged) stats.sourceRowsUpserted += 1;
        }

        if (stale && deactivateStale) {
          await archiveSharedAward(award, opportunities, source);
          stats.staleAwardsArchived += 1;
        }
        result.applied = true;
      }

      rowsToReview.push(...opportunities.map((opportunity) => reviewRow(award, source, opportunity, stale)));
      results.push(result);
      console.log(
        `${stale ? "STALE" : opportunities.length ? "FOUND" : "MISS "} | ${award.name} | opportunities=${opportunities.length} | ${source.url}`,
      );
    } catch (error) {
      stats.pagesFailed += 1;
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        awardId: award.id,
        awardName: award.name,
        sourceId: source.id,
        sourceUrl: source.url,
        status: "failed",
        error: message,
      });
      console.log(`FAILED | ${award.name} | ${message}`);
    }
  }
} finally {
  await browser?.close().catch(() => null);
}

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(reviewCsvPath), { recursive: true });
writeFileSync(
  outputPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), apply, applyNonStale, deactivateStale, stats, results }, null, 2),
  "utf8",
);
writeFileSync(reviewCsvPath, renderReviewCsv(rowsToReview), "utf8");

console.log(
  JSON.stringify(
    {
      outputPath,
      reviewCsvPath,
      apply,
      applyNonStale,
      deactivateStale,
      stats,
    },
    null,
    2,
  ),
);

async function readListingPage(url) {
  const staticPage = await readStaticPage(url).catch(() => null);
  if (staticPage && !looksLikeSecurityChallenge(staticPage)) return staticPage;
  return readRenderedPage(url);
}

async function readStaticPage(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "AwardPingListingReconciliation/1.0 (+https://awardping.com)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await response.text();
  const $ = cheerio.load(html);
  const scope = $("main, [role='main'], article, .entry-content, .content").first();
  const scoped = scope.length ? scope : $("body");
  const text = cleanLines(scoped.text()).join("\n");
  const links = scoped
    .find("a[href]")
    .toArray()
    .map((element) => {
      const link = $(element);
      const container = link.closest("article, section, li, div, p");
      return {
        href: link.attr("href") || "",
        text: cleanText(link.text() || link.attr("aria-label") || link.attr("title") || ""),
        contextText: cleanText(container.text() || ""),
      };
    });

  return {
    url: response.url || url,
    status: response.status,
    title: cleanText($("title").text()),
    text,
    links,
  };
}

async function readRenderedPage(url) {
  const activeBrowser = await getBrowser();
  const context = await activeBrowser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1365, height: 1800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AwardPingListingReconciliation/1.0",
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(renderDelayMs);
    return await page.evaluate(() => {
      const scope =
        document.querySelector("main") ||
        document.querySelector("[role='main']") ||
        document.querySelector("article") ||
        document.querySelector(".entry-content") ||
        document.querySelector(".content") ||
        document.body;
      const links = [...scope.querySelectorAll("a[href]")].map((link) => {
        const container = link.closest("article, section, li, div, p");
        return {
          href: link.getAttribute("href") || "",
          text: (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim(),
          contextText: (container?.innerText || "").replace(/\s+/g, " ").trim(),
        };
      });
      return {
        url: location.href,
        status: 200,
        title: document.title || "",
        text: (scope?.innerText || document.body?.innerText || "").replace(/\r/g, ""),
        links,
      };
    });
  } finally {
    await page.close().catch(() => null);
    await context.close().catch(() => null);
  }
}

async function getBrowser() {
  if (!browser) {
    const executablePath = findBrowserExecutable();
    browser = await chromium.launch({
      executablePath: executablePath || undefined,
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
  }
  return browser;
}

function extractOpportunities(pageData, source, award) {
  const baseUrl = pageData.url || source.url;
  const sourceKey = canonicalUrlKey(source.url);
  const lines = cleanLines(pageData.text);
  const candidates = [];
  const seen = new Set();

  for (const link of pageData.links || []) {
    const url = normalizeUrl(link.href, baseUrl);
    if (!url || seen.has(canonicalUrlKey(url))) continue;
    if (canonicalUrlKey(url) === sourceKey) continue;
    if (!isRelatedHost(hostName(url), hostName(baseUrl))) continue;
    if (isExcludedOpportunityUrl(url, link)) continue;

    const titleResult = opportunityTitleForLink(url, link, lines);
    const title = titleResult.title;
    if (!title || isGenericOpportunityTitle(title)) continue;

    const signal = `${url} ${title} ${link.text || ""} ${link.contextText || ""}`;
    if (!hasOpportunityTerms(signal)) continue;

    const score = opportunityScore(url, link, title, titleResult);
    if (score < 7) continue;

    seen.add(canonicalUrlKey(url));
    candidates.push({
      title,
      url,
      description: opportunityDescription(titleResult.lineIndex, lines, link.contextText),
      score,
      confidence: Math.min(0.93, 0.58 + score / 30),
      reason: `Discovered from listing page ${source.url}.`,
      source_award_id: award.id,
      source_award_name: award.name,
    });
  }

  return candidates
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, 8);
}

function opportunityTitleForLink(url, link, lines) {
  const linkText = cleanText(link.text);
  if (linkText && !isGenericLinkText(linkText) && !looksLikeBodySentence(linkText) && hasOpportunityTerms(linkText)) {
    return { title: linkText, matchedLine: linkText, lineIndex: -1, matchedFromPageText: false };
  }

  const pathTokens = pathOpportunityTokens(url);
  let best = { line: "", score: 0, index: -1 };
  if (pathTokens.length > 0) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.length < 8 || line.length > 190) continue;
      if (isGenericLinkText(line)) continue;
      if (looksLikeBodySentence(line)) continue;
      if (!hasOpportunityTerms(line)) continue;
      const normalized = normalizeText(line);
      const score = pathTokens.filter((token) => normalized.includes(token)).length;
      if (score > best.score) best = { line, score, index };
    }
  }

  const neededScore = pathTokens.length <= 2 ? Math.min(1, pathTokens.length) : 2;
  if (best.score >= neededScore && best.line) {
    const pathTitle = titleFromUrlPath(url);
    if (isLowQualityAwardTitle(best.line) && !isLowQualityAwardTitle(pathTitle)) {
      return { title: pathTitle, matchedLine: best.line, lineIndex: best.index, matchedFromPageText: false };
    }
    return { title: best.line, matchedLine: best.line, lineIndex: best.index, matchedFromPageText: true };
  }

  return {
    title: titleFromUrlPath(url),
    matchedLine: null,
    lineIndex: -1,
    matchedFromPageText: false,
  };
}

function opportunityDescription(lineIndex, lines, contextText) {
  if (lineIndex >= 0) {
    const following = lines
      .slice(lineIndex + 1, lineIndex + 4)
      .filter((line) => line.length >= 35 && !isGenericLinkText(line) && !looksLikeHeading(line));
    if (following.length) return following.join(" ").slice(0, 520);
  }

  const context = cleanText(contextText);
  if (context.length >= 45) return context.slice(0, 520);
  return null;
}

function opportunityScore(url, link, title, titleResult) {
  let score = 0;
  const signal = `${url} ${title} ${link.text || ""} ${link.contextText || ""}`.toLowerCase();
  if (titleResult.matchedFromPageText) score += 5;
  if (hasOpportunityTerms(title)) score += 5;
  if (/\/(scholarships?|fellowships?|grants?|awards?|financial-aid)\b/i.test(new URL(url).pathname)) score += 3;
  if (/\b(apply|application|deadline|eligib|membership|travel|doctoral|phd|research|guidelines?)\b/.test(signal)) score += 3;
  if (isGenericLinkText(link.text)) score -= 1;
  if (title.length > 16) score += 1;
  return score;
}

function isStaleListingAward(award, pageData, opportunities) {
  if (!opportunities.length) return false;
  if (opportunities.some((opportunity) => namesMatch(award.name, opportunity.title))) return false;

  const tokens = distinctiveTokens(award.name);
  if (tokens.length < 2) return false;
  const page = normalizeText(pageData.text);
  const matched = tokens.filter((token) => page.includes(token)).length;
  return matched < Math.min(2, Math.ceil(tokens.length * 0.45));
}

async function upsertOpportunityAward(opportunity, source, sourceAward) {
  const searchKey = normalizeSharedAwardKey(opportunity.title);
  const homepageKey = canonicalUrlKey(opportunity.url);
  const existingByKey = existingAwardsByKey.get(searchKey) || null;
  const existingByHomepage = existingAwardsByHomepage.get(homepageKey) || null;
  const existingAward = existingByKey || existingByHomepage || null;
  const now = new Date().toISOString();
  let awardId = existingAward?.id || null;
  let awardChanged = false;

  if (existingAward) {
    const previousSearchKey = existingAward.search_key;
    const searchKeyConflict = existingAwardsByKey.get(searchKey);
    const renameAward = shouldReplaceAwardTitle(existingAward.name, opportunity.title, existingAward.official_homepage, opportunity.url);
    const updates = {
      official_homepage: opportunity.url,
      status: "active",
      updated_at: now,
    };
    if (renameAward) {
      updates.name = opportunity.title;
      if (!searchKeyConflict || searchKeyConflict.id === existingAward.id) {
        updates.search_key = searchKey;
      }
    }
    if (!existingAward.slug || (renameAward && isLowQualitySlug(existingAward.slug, existingAward.name))) {
      updates.slug = uniqueAwardSlug(opportunity.title, existingAward.id);
    }
    if (!existingAward.summary && opportunity.description) {
      updates.summary = opportunity.description;
    }
    const { error } = await supabase.from("shared_awards").update(updates).eq("id", existingAward.id);
    if (error) throw new Error(`shared_awards update failed: ${error.message}`);
    Object.assign(existingAward, updates);
    existingAwardsByHomepage.set(homepageKey, existingAward);
    if (updates.search_key) {
      existingAwardsByKey.delete(previousSearchKey);
      existingAwardsByKey.set(searchKey, existingAward);
    }
    awardChanged = true;
  } else {
    const { data, error } = await supabase
      .from("shared_awards")
      .insert({
        search_key: searchKey,
        name: opportunity.title,
        slug: uniqueAwardSlug(opportunity.title),
        official_homepage: opportunity.url,
        summary: opportunity.description,
        confidence: opportunity.confidence,
        status: "active",
        source: "admin",
      })
      .select("id,search_key,name,slug,official_homepage,summary,confidence,status,source,updated_at")
      .single();
    if (error) throw new Error(`shared_awards insert failed: ${error.message}`);
    awardId = data.id;
    existingAwardsByKey.set(searchKey, data);
    existingAwardsByHomepage.set(homepageKey, data);
    awardChanged = true;
  }

  const sourceKey = `${awardId}\n${canonicalUrlKey(opportunity.url)}`;
  const sourceChanged = !existingSourceKeys.has(sourceKey);
  const { error: sourceError } = await supabase.from("shared_award_sources").upsert(
    {
      shared_award_id: awardId,
      url: opportunity.url,
      title: opportunity.title,
      page_type: "homepage",
      confidence: opportunity.confidence,
      reason: `${opportunity.reason} Original stale/broad record: ${sourceAward.name}.`,
      source: "admin",
      next_check_at: now,
      updated_at: now,
    },
    { onConflict: "shared_award_id,url" },
  );
  if (sourceError) throw new Error(`shared_award_sources upsert failed: ${sourceError.message}`);
  existingSourceKeys.add(sourceKey);
  return { awardId, awardChanged, sourceChanged };
}

function shouldReplaceAwardTitle(currentTitle, nextTitle, currentUrl, nextUrl) {
  if (cleanText(currentTitle) === cleanText(nextTitle)) return false;
  if (canonicalUrlKey(currentUrl) !== canonicalUrlKey(nextUrl)) return false;
  return isLowQualityAwardTitle(currentTitle) || !hasOpportunityTerms(currentTitle);
}

function isLowQualityAwardTitle(value) {
  const clean = cleanText(value);
  return (
    /\b(19|20)\d{2}\b/.test(clean) ||
    /\b(application|program)?\s*guidelines?\b/i.test(clean) ||
    /\b(pdf|document|download)\b/i.test(clean)
  );
}

function isLowQualitySlug(slug, title) {
  const cleanSlug = String(slug || "");
  return (
    cleanSlug.length < 12 ||
    /\b(19|20)\d{2}\b/.test(cleanSlug) ||
    /\b(application|program)?-?guidelines?\b/i.test(cleanSlug) ||
    isLowQualityAwardTitle(title)
  );
}

async function archiveSharedAward(award, opportunities, source) {
  const replacementNames = opportunities.map((opportunity) => opportunity.title).join("; ");
  const { error } = await supabase
    .from("shared_awards")
    .update({
      status: "archived",
      structure_scan_error: `Archived by listing reconciliation. Source page ${source.url} now lists: ${replacementNames}.`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", award.id);
  if (error) throw new Error(`shared_awards archive failed: ${error.message}`);
}

function isListingSource(source) {
  const value = `${source.url} ${source.title || ""}`;
  if (source.page_type === "pdf") return false;
  return /\b(scholarships?|fellowships?|grants?|awards?|opportunities|funding|financial aid|financial-aid)\b/i.test(value);
}

function looksLikeSecurityChallenge(pageData) {
  const text = `${pageData.status || ""} ${pageData.url || ""} ${pageData.title || ""} ${pageData.text || ""}`.toLowerCase();
  return (
    pageData.status === 202 ||
    text.length < 80 ||
    /sgcaptcha|robot challenge|checking.*secure|checking.*browser|just a moment|cloudflare|enable javascript/.test(text)
  );
}

function isExcludedOpportunityUrl(url, link) {
  const parsed = new URL(url);
  const lower = `${parsed.pathname} ${link.text || ""} ${link.contextText || ""}`.toLowerCase();
  if (parsed.hash && parsed.pathname === "/") return true;
  const isDocument = /\.(pdf|docx?)$/i.test(parsed.pathname);
  if (isDocument) {
    return !hasOpportunityTerms(lower) || isNonOpportunityDocument(lower);
  }
  if (/\.(xlsx?|pptx?|zip|png|jpe?g|gif|webp|svg)$/i.test(parsed.pathname)) return true;
  if (/^\/(resources?|scholarships?|fellowships?|grants?|awards?|opportunities|funding|student-programs|volta-voices|professionals|chapters|values|advocacy|people|our-people)\/?$/i.test(parsed.pathname)) return true;
  if (/wp-login|logout|login|signin|sign-in|donate|careers?|jobs?|privacy|terms|bylaws|council-intranet|directory|member-portal|membership\/?$|research\/?$|conferences?\/?$/.test(lower)) {
    return !hasOpportunityTerms(lower);
  }
  return false;
}

function hasOpportunityTerms(value) {
  return /\b(scholarships?|fellowships?|grants?|awards?|funding|financial aid|tuition assistance|stipend|travel grant|membership scholarship|application guidelines?|program guidelines?|application guide|program guide|guidelines?)\b/i.test(
    String(value || "").replace(/\baward-winning\b/gi, ""),
  );
}

function isNonOpportunityDocument(value) {
  return /\b(annual report|strategic plan|sponsorship|prospectus|speaker bios?|disclosures?|registration form|job opening|internship job|bibliography|toolkit|position statement|getting started guide|research|magazine|newsletter)\b/i.test(
    String(value || ""),
  );
}

function namesMatch(left, right) {
  const leftTokens = distinctiveTokens(left);
  const rightText = normalizeText(right);
  if (leftTokens.length === 0) return false;
  const matched = leftTokens.filter((token) => rightText.includes(token)).length;
  return matched >= Math.min(2, Math.ceil(leftTokens.length * 0.55));
}

function distinctiveTokens(value) {
  const stop = new Set([
    "ais",
    "the",
    "and",
    "for",
    "with",
    "association",
    "american",
    "international",
    "information",
    "systems",
    "award",
    "awards",
    "fellowship",
    "fellowships",
    "scholarship",
    "scholarships",
    "grant",
    "grants",
    "program",
    "programs",
    "student",
    "students",
  ]);
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !stop.has(token))
    .slice(0, 12);
}

function pathOpportunityTokens(value) {
  try {
    return distinctiveTokens(
      decodeURIComponent(new URL(value).pathname)
        .replace(/\.[a-z0-9]+$/i, "")
        .replace(/[/_-]+/g, " "),
    );
  } catch {
    return [];
  }
}

function isGenericLinkText(value) {
  return /^(learn more|read more|more|details?|apply|application|guidelines?|program guide|application guide|click here|here|view|open|download|skip to content)$/i.test(
    cleanText(value),
  );
}

function isGenericOpportunityTitle(value) {
  return /^(scholarships?|fellowships?|grants?|awards?|resources?|apply for a scholarship|learn more|home|application|guidelines?)$/i.test(
    cleanText(value),
  );
}

function looksLikeHeading(value) {
  const clean = cleanText(value);
  return clean.length <= 90 && /^[A-Z0-9 &|:'’().,-]+$/.test(clean);
}

function looksLikeBodySentence(value) {
  const clean = cleanText(value);
  return clean.length > 85 && /[.!?;:]/.test(clean);
}

function titleFromUrlPath(value) {
  try {
    const pathname = decodeURIComponent(new URL(value).pathname);
    const lower = pathname.toLowerCase();
    if (/(^|[^a-z0-9])parent[-_ ]?infant([^a-z0-9]|$)/.test(lower)) return "Parent & Infant Financial Aid";
    if (/(^|[^a-z0-9])preschool([^a-z0-9]|$)/.test(lower)) return "Preschool Financial Aid";
    if (/(^|[^a-z0-9])school[-_ ]?age([^a-z0-9]|$)/.test(lower)) return "School-Age Financial Aid";
    if (/(^|[^a-z0-9])arts[-_ ]?sciences?([^a-z0-9]|$)/.test(lower)) return "Arts & Sciences Award";
    if (/(^|[^a-z0-9])nofer([^a-z0-9]|$)/.test(lower)) return "George H. Nofer Scholarship for Law";
    const segment = pathname.split("/").filter(Boolean).pop() || "Opportunity";
    return titleCase(segment.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " "));
  } catch {
    return "Opportunity";
  }
}

function normalizeUrl(value, baseUrl) {
  if (!value || /^mailto:|^tel:/i.test(value)) return null;
  try {
    const parsed = new URL(value, baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function canonicalUrlKey(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.hostname = normalizeHost(parsed.hostname);
    parsed.pathname = parsed.pathname.replace(/\/+$/g, "") || "/";
    if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.toLowerCase();
    parsed.search = "";
    return parsed.toString();
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

function normalizeSharedAwardKey(name) {
  return cleanText(name).toLowerCase().replace(/\s+/g, " ");
}

function uniqueAwardSlug(name, awardId = null) {
  const base = conciseAwardSlug(name);
  let candidate = base;
  let index = 2;
  while (true) {
    const existing = existingAwardsBySlug.get(candidate);
    if (!existing || existing.id === awardId) {
      existingAwardsBySlug.set(candidate, { id: awardId || `pending:${candidate}` });
      return candidate;
    }
    candidate = `${base}-${index}`;
    index += 1;
  }
}

function conciseAwardSlug(name) {
  const clean = cleanText(name)
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(application|program)?\s*guidelines?\b/gi, " ")
    .replace(/\b(pdf|document|download)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const opportunityPart = clean
    .split(/\s[-–—:]\s/)
    .reverse()
    .find((part) => /\b(scholarship|fellowship|grant|award|financial aid|program)\b/i.test(part)) ||
    clean;
  const slug = opportunityPart
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .split("-")
    .filter(Boolean)
    .slice(0, 8)
    .join("-");
  return slug || "award";
}

function hostName(value) {
  try {
    return normalizeHost(new URL(value).hostname);
  } catch {
    return "";
  }
}

function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/^www\./, "");
}

function isRelatedHost(left, right) {
  const a = normalizeHost(left);
  const b = normalizeHost(right);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function normalizeText(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanLines(value) {
  return String(value || "")
    .split(/\r?\n+/)
    .map(cleanText)
    .filter(Boolean);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function titleCase(value) {
  return cleanText(value)
    .split(/\s+/)
    .map((word) => {
      if (/^(ais|phd|usa|us|uk)$/i.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function reviewRow(award, source, opportunity, stale) {
  return {
    stale: stale ? "yes" : "no",
    source_award_name: award.name,
    source_url: source.url,
    opportunity_title: opportunity.title,
    opportunity_url: opportunity.url,
    score: String(opportunity.score),
    confidence: String(opportunity.confidence.toFixed(2)),
    description: opportunity.description || "",
  };
}

function renderReviewCsv(rows) {
  const headers = [
    "stale",
    "source_award_name",
    "source_url",
    "opportunity_title",
    "opportunity_url",
    "score",
    "confidence",
    "description",
  ];
  return `${[headers, ...rows.map((row) => headers.map((key) => row[key] || ""))]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n")}\n`;
}

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

function createSupabaseClient() {
  const env = { ...loadEnvFile(resolve(root, ".env.local")), ...process.env };
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

function loadEnvFile(path) {
  try {
    const env = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[match[1]] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function findBrowserExecutable() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.PROGRAMFILES || "";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "";
  const candidates = [
    process.env.CHROME_PATH,
    localAppData ? join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : null,
    programFiles ? join(programFiles, "Google", "Chrome", "Application", "chrome.exe") : null,
    programFilesX86 ? join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe") : null,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    const clean = arg.replace(/^--/, "");
    const [key, ...rest] = clean.split("=");
    parsed[key] = rest.length ? rest.join("=") : true;
  }
  return parsed;
}

function boolArg(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  return /^(1|true|yes)$/i.test(String(value));
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
