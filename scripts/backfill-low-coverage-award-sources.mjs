#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as cheerio from "cheerio";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";
import { csvEscape } from "./source-cleanup-core.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const apply = args.apply === true || args.apply === "true";
const limit = positiveInt(args.limit, 0);
const maxExistingSources = positiveInt(args["max-existing-sources"], 1);
const maxPerAward = positiveInt(args["max-per-award"], 1);
const maxSearchResults = positiveInt(args["max-search-results"], 8);
const minScore = positiveInt(args["min-score"], 55);
const concurrency = positiveInt(args.concurrency, 2);
const timeoutMs = positiveInt(args["timeout-ms"], 20_000);
const delayMs = positiveInt(args["delay-ms"], 800);
const verifyPages = args["verify-pages"] !== "false";
const includeOneSource = args["include-one-source"] !== "false";
const onlyZero = args["only-zero"] === "true";
const officialHomepageOnly = args["official-homepage-only"] === "true";
const reviewOnly = args["review-only"] === "true";
const awardFilter = normalizeText(args.award || args["award-name"] || "");
const outputPath =
  args.output ||
  join(root, "reports", `low-coverage-source-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const reviewOutputPath =
  args["review-output"] ||
  join(root, "reports", `manual-source-review-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);

const ignoredHosts = new Set([
  "asu.edu",
  "illinois.edu",
  "ucla.edu",
  "uky.edu",
  "sc.edu",
  "profellow.com",
  "scholarshipdb.net",
  "scholars4dev.com",
  "studentscholarships.org",
  "wikipedia.org",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "onlineapplicationportal.com",
  "submittable.com",
  "smapply.io",
  "twitter.com",
  "x.com",
  "youtube.com",
  "dxdyhosting.xyz",
]);
const phoneNumberPathSegment = /(?:^|\/)\+?(?:\d[\d().-]*){9,}(?:\/|$)/;

const ignoredExactHosts = new Set([
  "fellowship-finder.grad.illinois.edu",
  "onsa.asu.edu",
  "competitiveawards.uky.edu",
  "grad.ucla.edu",
  "a.cms.omniupdate.com",
  "ncbi.nlm.nih.gov",
  "grad.uchicago.edu",
  "apply07.grants.gov",
  "federalregister.gov",
  "research.fas.harvard.edu",
  "researchfunding.duke.edu",
  "usgovernmentmanual.gov",
  "2021-2025.state.gov",
]);

const genericWords = new Set([
  "academy",
  "american",
  "association",
  "award",
  "awards",
  "center",
  "college",
  "committee",
  "council",
  "department",
  "doctoral",
  "foundation",
  "fellow",
  "fellowship",
  "fellowships",
  "fund",
  "graduate",
  "grants",
  "institute",
  "international",
  "memorial",
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
  "society",
  "student",
  "students",
  "university",
]);

const supabase = createSupabaseClient();
const { awards, sources } = await loadCatalog();
const sourceCounts = new Map();
const sourcesByAwardId = new Map();
for (const source of sources) {
  sourceCounts.set(source.shared_award_id, (sourceCounts.get(source.shared_award_id) || 0) + 1);
  sourcesByAwardId.set(source.shared_award_id, [...(sourcesByAwardId.get(source.shared_award_id) || []), source]);
}

const existingCanonicalKeys = new Set(
  sources.map((source) => `${source.shared_award_id}\n${canonicalUrlKey(source.url)}`),
);

const targets = awards
  .filter((award) => {
    const count = sourceCounts.get(award.id) || 0;
    const awardSources = sourcesByAwardId.get(award.id) || [];
    const missingHomepageSource = shouldAddOfficialHomepageSource(award, awardSources);
    if (awardFilter && !award.name.toLowerCase().includes(awardFilter.toLowerCase())) return false;
    if (officialHomepageOnly) return missingHomepageSource;
    if (missingHomepageSource) return true;
    if (onlyZero) return count === 0;
    if (count === 0) return true;
    if (!includeOneSource || count > maxExistingSources) return false;
    return awardSources.some((source) => shouldImproveOneSourceAward(source));
  })
  .sort((left, right) => {
    const countDelta = (sourceCounts.get(left.id) || 0) - (sourceCounts.get(right.id) || 0);
    if (countDelta !== 0) return countDelta;
    return left.name.localeCompare(right.name);
  });

const limitedTargets = limit > 0 ? targets.slice(0, limit) : targets;
console.log(
  `Searching ${limitedTargets.length}/${targets.length} low-coverage awards; apply=${apply}; minScore=${minScore}.`,
);

const stats = {
  awardsSearched: 0,
  awardsWithCandidates: 0,
  inserted: 0,
  skippedExisting: 0,
  failed: 0,
};
const rowsToInsert = [];
const results = [];
const reviewRows = [];

await mapWithConcurrency(limitedTargets, concurrency, async (award) => {
  stats.awardsSearched += 1;
  try {
    const candidates = await findOfficialSourceCandidates(award);
    const autoAccepted = candidates
      .filter((candidate) => candidate.score >= minScore)
      .filter((candidate) => {
        const key = `${award.id}\n${canonicalUrlKey(candidate.url)}`;
        if (existingCanonicalKeys.has(key)) {
          stats.skippedExisting += 1;
          return false;
        }
        existingCanonicalKeys.add(key);
        return true;
      })
      .slice(0, maxPerAward);
    const accepted = reviewOnly ? [] : autoAccepted;

    if (accepted.length || (reviewOnly && candidates.length)) {
      stats.awardsWithCandidates += 1;
    }

    if (accepted.length) {
      for (const candidate of accepted) {
        rowsToInsert.push(rowForCandidate(award, candidate));
      }
    }

    if (reviewOnly && candidates.length) {
      for (const candidate of candidates.slice(0, Math.max(5, maxPerAward))) {
        reviewRows.push(reviewRowForCandidate(award, candidate, candidate.score >= minScore));
      }
    }

    results.push({
      awardId: award.id,
      awardName: award.name,
      sourceCount: sourceCounts.get(award.id) || 0,
      status: accepted.length ? "accepted" : candidates.length ? "review" : "miss",
      accepted: reviewOnly ? [] : accepted,
      autoEligible: reviewOnly ? autoAccepted : [],
      topCandidates: candidates.slice(0, 5),
    });

    const label = accepted.length ? "FOUND" : candidates.length ? "REVIEW" : "MISS";
    console.log(`${label.padEnd(6, " ")} ${award.name}`);
    for (const candidate of accepted) {
      console.log(`  - ${candidate.score} ${candidate.url}`);
    }
  } catch (error) {
    stats.failed += 1;
    results.push({
      awardId: award.id,
      awardName: award.name,
      sourceCount: sourceCounts.get(award.id) || 0,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      accepted: [],
      topCandidates: [],
    });
    console.log(`FAILED ${award.name} | ${error instanceof Error ? error.message : String(error)}`);
  }
});

if (apply && rowsToInsert.length && !reviewOnly) {
  stats.inserted = await insertSourceRows(rowsToInsert);
}

if (reviewOnly) {
  mkdirSync(dirname(reviewOutputPath), { recursive: true });
  writeFileSync(reviewOutputPath, renderReviewCsv(reviewRows), "utf8");
}

const report = {
  generatedAt: new Date().toISOString(),
  apply,
  options: {
    limit,
    maxExistingSources,
    maxPerAward,
    maxSearchResults,
    minScore,
    concurrency,
    delayMs,
    includeOneSource,
    onlyZero,
    officialHomepageOnly,
    reviewOnly,
    verifyPages,
    awardFilter: awardFilter || null,
    reviewOutputPath: reviewOnly ? reviewOutputPath : null,
  },
  stats: {
    ...stats,
    targetsTotal: targets.length,
    rowsReady: rowsToInsert.length,
  },
  rowsToInsert,
  reviewRows,
  results: results.sort((left, right) => left.awardName.localeCompare(right.awardName)),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ outputPath, reviewOutputPath: reviewOnly ? reviewOutputPath : null, ...report.stats }, null, 2));

async function findOfficialSourceCandidates(award) {
  const directCandidates = [];
  const directHomepageCandidate = officialHomepageCandidate(award);
  if (directHomepageCandidate) directCandidates.push(directHomepageCandidate);
  if (officialHomepageOnly) return directCandidates;

  const queries = searchQueriesForAward(award.name);
  const resultRows = [];
  for (const query of queries) {
    resultRows.push(...(await searchWeb(query)));
    if (delayMs > 0) await sleep(delayMs);
  }

  const byUrl = new Map();
  for (const result of resultRows) {
    const normalized = normalizeResultUrl(result.url);
    if (!normalized) continue;
    const existing = byUrl.get(canonicalUrlKey(normalized));
    const candidate = scoreSearchResult(award, { ...result, url: normalized });
    if (!candidate) continue;
    if (!existing || candidate.score > existing.score) {
      byUrl.set(canonicalUrlKey(candidate.url), candidate);
    }
  }

  const scored = [...byUrl.values()].sort(
    (left, right) => right.score - left.score || left.rank - right.rank || left.url.length - right.url.length,
  );

  if (!verifyPages) return scored;

  const verified = [];
  for (const candidate of scored.slice(0, Math.max(6, maxPerAward * 4))) {
    if (candidate.score < Math.max(24, minScore - 15)) continue;
    const verification = await verifyCandidatePage(award, candidate);
    if (verification.ok) {
      verified.push({
        ...candidate,
        score: candidate.score + verification.bonus,
        confidence: Math.min(0.95, Number((candidate.confidence + verification.bonus / 100).toFixed(2))),
        verification: verification.reason,
      });
    }
    if (delayMs > 0) await sleep(Math.min(delayMs, 500));
  }

  return [...directCandidates, ...verified].sort(
    (left, right) => right.score - left.score || left.rank - right.rank || left.url.length - right.url.length,
  );
}

function officialHomepageCandidate(award) {
  const sourceUrl = normalizeResultUrl(award.official_homepage || "");
  if (!sourceUrl) return null;

  const candidate = scoreSearchResult(award, {
    url: sourceUrl,
    title: award.name,
    snippet: "Existing official homepage stored on the award record.",
    query: "existing official_homepage",
    rank: 1,
  });
  if (!candidate) return null;

  return {
    ...candidate,
    score: Math.max(candidate.score, 85),
    confidence: Math.max(candidate.confidence, 0.9),
    pageType: candidate.pageType === "pdf" ? "pdf" : "homepage",
    reason: "Backfilled from the award's existing official homepage field.",
    verification: "Accepted from existing official_homepage after URL policy checks.",
  };
}

function searchQueriesForAward(name) {
  const clean = normalizeText(name);
  const noParens = normalizeText(clean.replace(/\([^)]*\)/g, " "));
  const parts = clean.split(/\s+-\s+/).map((part) => normalizeText(part)).filter(Boolean);
  const org = parts[0] || clean;
  const program = parts.slice(1).join(" ");
  const acronyms = [...clean.matchAll(/\(([A-Z0-9&/-]{2,})\)/g)]
    .map((match) => match[1].replace(/[^A-Z0-9]+/g, " "))
    .filter(Boolean);
  const compactName = compactQueryText(noParens);
  const compactProgram = compactQueryText(program);
  const queries = [
    `${noParens} official website`,
    compactName ? `${compactName} official` : "",
    program ? `${org} ${program} official` : `${clean} official`,
    acronyms.length && program ? `${acronyms.join(" ")} ${program} official` : "",
    acronyms.length && compactProgram ? `${acronyms.join(" ")} ${compactProgram} official` : "",
    `${clean} application eligibility deadline`,
  ];
  return [...new Set(queries.map((query) => normalizeText(query)).filter(Boolean))].slice(0, 4);
}

function compactQueryText(value) {
  const stopwords = new Set(["a", "an", "and", "at", "by", "for", "from", "in", "into", "of", "on", "the", "to", "with"]);
  return normalizeText(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((part) => part && !stopwords.has(part.toLowerCase()))
    .slice(0, 9)
    .join(" ");
}

async function searchWeb(query) {
  try {
    const duckResults = await searchDuckDuckGo(query);
    if (duckResults.length) return duckResults;
  } catch (error) {
    if (!/HTTP 403|HTTP 429/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
  }

  return searchBing(query);
}

async function searchDuckDuckGo(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 AwardPingSourceBackfill/1.0 (+https://awardping.com)",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) throw new Error(`DuckDuckGo search failed with HTTP ${response.status}.`);

  const $ = cheerio.load(await response.text());
  const rows = [];
  $(".result").each((index, element) => {
    const link = $(element).find(".result__a").first();
    const href = link.attr("href");
    const title = normalizeText(link.text());
    const snippet = normalizeText($(element).find(".result__snippet").text());
    const url = decodeDuckDuckGoUrl(href || "");
    if (!url) return;
    rows.push({
      url,
      title: title || url,
      snippet,
      query,
      rank: index + 1,
    });
  });

  return rows.slice(0, maxSearchResults);
}

async function searchBing(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 AwardPingSourceBackfill/1.0 (+https://awardping.com)",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) throw new Error(`Bing search failed with HTTP ${response.status}.`);

  const $ = cheerio.load(await response.text());
  const rows = [];
  $("li.b_algo").each((index, element) => {
    const link = $(element).find("h2 a").first();
    const href = link.attr("href");
    const title = normalizeText(link.text());
    const snippet = normalizeText($(element).find(".b_caption p").text());
    const decoded = decodeBingUrl(href || "");
    if (!decoded) return;
    rows.push({
      url: decoded,
      title: title || decoded,
      snippet,
      query,
      rank: index + 1,
    });
  });

  return rows.slice(0, maxSearchResults);
}

function scoreSearchResult(award, result) {
  let parsed;
  try {
    parsed = new URL(result.url);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  if (isExcludedUrl(parsed)) return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const domain = registrableDomain(host);
  if (ignoredExactHosts.has(host) || ignoredHosts.has(domain)) return null;
  if (isMismatchedCampusHost(host, award.name)) return null;
  if (isGenericNewsOrBlogPath(parsed)) return null;
  if (isPastAnnouncementPath(parsed)) return null;
  if (isGenericCommunityPath(parsed)) return null;
  if (parsed.pathname !== "/" && !isAwardPageLikePath(parsed, result.title)) return null;

  const text = normalizeText(`${result.title} ${result.snippet} ${result.url}`).toLowerCase();
  const awardTokens = significantTokens(award.name);
  const nameParts = award.name.split(/\s+-\s+/).map((part) => normalizeText(part)).filter(Boolean);
  const orgName = nameParts[0] || award.name;
  const programName = nameParts.slice(1).join(" ") || award.name;
  const orgTokens = significantTokens(orgName);
  const programTokens = significantTokens(programName);
  const isRootPath = parsed.pathname === "/" || parsed.pathname === "";
  if (isRootPath && domain.endsWith(".gov") && programTokens.length >= 2) return null;
  const parentheticalAcronyms = [...award.name.matchAll(/\(([A-Z0-9&/-]{2,})\)/g)].map((match) =>
    match[1].toLowerCase().replace(/[^a-z0-9]+/g, ""),
  );
  const derivedAcronyms = derivedAcronymsForAwardName(orgName);
  const hostRelated = isHostRelatedToAward(host, orgTokens, parentheticalAcronyms, derivedAcronyms);
  if (!hostRelated && !domain.endsWith(".gov")) return null;
  if (!hostRelated && domain.endsWith(".gov") && (parsed.pathname === "/" || parsed.pathname === "")) {
    return null;
  }

  let score = 0;
  score += Math.max(0, 12 - result.rank);
  if (parsed.protocol === "https:") score += 3;
  if (!parsed.search) score += 5;
  if (domain.endsWith(".gov")) score += 10;
  if (domain.endsWith(".org")) score += 3;

  const exactPhrases = exactPhraseCandidates(award.name);
  if (exactPhrases.some((phrase) => phrase.length >= 12 && text.includes(phrase))) score += 18;

  let tokenHits = 0;
  for (const token of awardTokens) {
    if (text.includes(token)) tokenHits += 1;
  }
  score += Math.min(18, tokenHits * 3);

  let programHits = 0;
  for (const token of programTokens) {
    if (text.includes(token)) programHits += 1;
  }
  if (programTokens.length && programHits === 0 && parsed.pathname !== "/") return null;
  if (programHits > 0) score += Math.min(12, programHits * 3);

  let hostHits = 0;
  for (const token of orgTokens) {
    if (host.includes(token)) hostHits += 1;
  }
  score += Math.min(16, hostHits * 5);

  for (const acronym of parentheticalAcronyms) {
    if (acronym && (host.includes(acronym) || text.includes(acronym))) score += 8;
  }

  if (/\b(official|homepage|website)\b/.test(text)) score += 4;
  if (/\b(apply|application|eligib|deadline|requirement|faq|guidelines?)\b/.test(text)) score += 4;
  if (/\/(apply|application|eligib|deadline|faq|requirements?|guidelines?)/i.test(parsed.pathname)) score += 5;
  if (parsed.pathname === "/" || parsed.pathname === "") score += 3;
  if (/\.pdf$/i.test(parsed.pathname)) score -= 8;
  if (/\b(news|press|blog|calendar|event|jobs?|careers?|donate|give|privacy|terms)\b/i.test(text)) score -= 10;

  if (score < 18) return null;

  return {
    url: parsed.toString(),
    title: cleanTitle(result.title, parsed),
    snippet: result.snippet,
    query: result.query,
    rank: result.rank,
    score,
    confidence: Math.min(0.92, Number((0.45 + score / 80).toFixed(2))),
    pageType: classifyPageType(parsed, result.title),
    reason: `Found by low-coverage official source search; rank ${result.rank} for "${result.query}".`,
  };
}

async function verifyCandidatePage(award, candidate) {
  let response;
  try {
    response = await fetch(candidate.url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 AwardPingSourceVerifier/1.0 (+https://awardping.com)",
        accept: "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.8,*/*;q=0.5",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, bonus: 0, reason: error instanceof Error ? error.message : "fetch failed" };
  }

  if (!response.ok) {
    return { ok: false, bonus: 0, reason: `HTTP ${response.status}` };
  }

  const contentType = response.headers.get("content-type") || "";
  const urlText = candidate.url.toLowerCase();
  if (contentType.includes("application/pdf") || /\.pdf($|\?)/i.test(candidate.url)) {
    return urlContainsProgramTerms(award, urlText)
      ? { ok: true, bonus: 4, reason: "PDF URL contains program terms." }
      : { ok: false, bonus: 0, reason: "PDF URL did not contain enough program terms." };
  }

  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml") && !contentType.includes("text/plain")) {
    return { ok: false, bonus: 0, reason: `Unsupported content type ${contentType || "unknown"}.` };
  }

  const html = await response.text();
  const pageText = contentType.includes("html")
    ? normalizeText(cheerio.load(html)("body").text())
    : normalizeText(html);
  const haystack = `${candidate.url} ${candidate.title} ${pageText}`.toLowerCase();
  const exact = exactPhraseCandidates(award.name).some((phrase) => phrase.length >= 12 && haystack.includes(phrase));
  const nameParts = award.name.split(/\s+-\s+/).map((part) => normalizeText(part)).filter(Boolean);
  const programName = nameParts.slice(1).join(" ") || award.name;
  const programTokens = significantTokens(programName);
  const awardTokens = significantTokens(award.name);
  const programHits = countTokenHits(programTokens, haystack);
  const awardHits = countTokenHits(awardTokens, haystack);

  if (exact) return { ok: true, bonus: 8, reason: "Page contains exact award phrase." };
  if (programTokens.length && programHits >= 2) {
    return { ok: true, bonus: 6, reason: `Page contains ${programHits} program terms.` };
  }
  if (programTokens.length && programHits >= 1 && awardHits >= 3) {
    return { ok: true, bonus: 5, reason: "Page contains program and award terms." };
  }
  if (!programTokens.length && awardHits >= 3) {
    return { ok: true, bonus: 4, reason: "Page contains award terms." };
  }

  return {
    ok: false,
    bonus: 0,
    reason: `Page term match too weak: ${programHits} program hits, ${awardHits} award hits.`,
  };
}

function urlContainsProgramTerms(award, urlText) {
  const nameParts = award.name.split(/\s+-\s+/).map((part) => normalizeText(part)).filter(Boolean);
  const programName = nameParts.slice(1).join(" ") || award.name;
  return countTokenHits(significantTokens(programName), urlText) >= 1;
}

function countTokenHits(tokens, haystack) {
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits;
}

function isHostRelatedToAward(host, orgTokens, parentheticalAcronyms, derivedAcronyms) {
  const compactHost = host.replace(/[^a-z0-9]+/g, "");
  for (const acronym of [...parentheticalAcronyms, ...derivedAcronyms]) {
    const compactAcronym = acronym.replace(/[^a-z0-9]+/g, "");
    if (compactAcronym.length >= 3 && compactHost.includes(compactAcronym)) return true;
  }

  let tokenHits = 0;
  for (const token of orgTokens) {
    if (token.length >= 4 && compactHost.includes(token)) tokenHits += 1;
  }
  if (tokenHits >= 2) return true;
  if (parentheticalAcronyms.length) return false;
  if (orgTokens.some((token) => /\d/.test(token) && compactHost.includes(token))) return true;
  if (orgTokens[0] && orgTokens[0].length >= 5 && compactHost.includes(orgTokens[0])) return true;

  return false;
}

function derivedAcronymsForAwardName(value) {
  const words = String(value || "")
    .replace(/&/g, " and ")
    .match(/[A-Za-z0-9]+/g) || [];
  const meaningful = words.filter((word) => {
    const lower = word.toLowerCase();
    return lower.length > 1 && !["and", "for", "from", "in", "of", "the", "to", "with"].includes(lower);
  });
  const acronyms = [];
  if (meaningful.length >= 2) {
    acronyms.push(meaningful.map((word) => word[0]).join("").toLowerCase());
  }
  if (meaningful.length >= 3) {
    acronyms.push(meaningful.slice(0, 3).map((word) => word[0]).join("").toLowerCase());
  }
  return acronyms;
}

function isMismatchedCampusHost(host, awardName) {
  if (!/\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/.test(host)) return false;
  const lowerAward = awardName.toLowerCase();
  const requiredInstitutionTokens = leadingInstitutionTokens(awardName);
  if (
    requiredInstitutionTokens.length &&
    !requiredInstitutionTokens.some((token) => host.replace(/[^a-z0-9]+/g, "").includes(token))
  ) {
    return true;
  }

  const hostParts = host.split(".").filter(Boolean);
  const domainRoot = registrableDomain(host).split(".")[0] || "";
  const possibleTokens = new Set([
    domainRoot,
    domainRoot.replace(/^u/, ""),
    ...hostParts.map((part) => part.replace(/^u/, "")),
  ]);

  if (domainRoot === "edu") return false;
  for (const token of possibleTokens) {
    if (token.length >= 4 && lowerAward.includes(token)) return false;
  }
  return true;
}

function leadingInstitutionTokens(awardName) {
  const lower = awardName.toLowerCase();
  const patterns = [
    /^university of ([a-z][a-z\s&.-]+?)(?:\s+-|\s\/|$)/,
    /^([a-z][a-z\s&.-]+?) university(?:\s+-|\s\/|$)/,
    /^([a-z][a-z\s&.-]+?) college(?:\s+-|\s\/|$)/,
  ];
  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (!match) continue;
    return significantTokens(match[1]).map((token) => token.replace(/[^a-z0-9]+/g, ""));
  }
  return [];
}

function isGenericNewsOrBlogPath(url) {
  return /\/(news|blog|blogs|announcements?|press|magazine)\b/i.test(url.pathname);
}

function isPastAnnouncementPath(url) {
  const lower = url.pathname.toLowerCase();
  return (
    /(awards?|fellows?|winners?|recipients?)-(announced|named)|announced|winners?|recipients?/.test(lower) ||
    /application-open/.test(lower) ||
    /\/20\d{2}[-/](fellows?|winners?|recipients?|class|cohort)\b/.test(lower) ||
    /\/20\d{2}[-/].*\b(call|announcement)\b/.test(lower)
  );
}

function isGenericCommunityPath(url) {
  return /\/(communities?|community-home|digestviewer|viewthread|forums?|discussion|profile|people)\b/i.test(url.pathname);
}

function isAwardPageLikePath(url, title) {
  const lower = `${url.pathname} ${title}`.toLowerCase();
  return /(fellow|scholar|award|grant|program|apply|application|deadline|eligib|requirement|guideline|research|internship|opportunit)/.test(lower);
}

function rowForCandidate(award, candidate) {
  return {
    shared_award_id: award.id,
    url: candidate.url,
    title: candidate.title,
    page_type: candidate.pageType,
    confidence: candidate.confidence,
    reason: candidate.reason,
    source: "admin",
  };
}

function reviewRowForCandidate(award, candidate, autoEligible) {
  return {
    awardId: award.id,
    awardName: award.name,
    sourceCount: sourceCounts.get(award.id) || 0,
    candidateUrl: candidate.url,
    candidateTitle: candidate.title,
    pageType: candidate.pageType,
    score: candidate.score,
    confidence: candidate.confidence,
    autoEligible,
    query: candidate.query,
    verification: candidate.verification || "",
    reason: candidate.reason,
  };
}

function renderReviewCsv(rows) {
  const headers = [
    "award_id",
    "award_name",
    "source_count",
    "candidate_title",
    "candidate_url",
    "page_type",
    "score",
    "confidence",
    "auto_eligible",
    "query",
    "verification",
    "reason",
  ];
  return `${[headers, ...rows.map((row) => [
    row.awardId,
    row.awardName,
    row.sourceCount,
    row.candidateTitle,
    row.candidateUrl,
    row.pageType,
    row.score,
    row.confidence,
    row.autoEligible ? "yes" : "no",
    row.query,
    row.verification,
    row.reason,
  ])].map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

async function insertSourceRows(rows) {
  let count = 0;
  for (const batch of chunk(rows, 100)) {
    const { data, error } = await supabase
      .from("shared_award_sources")
      .upsert(batch, { onConflict: "shared_award_id,url" })
      .select("id");
    if (error) throw new Error(`shared_award_sources upsert failed: ${error.message}`);
    count += data?.length || 0;
  }

  const homepageRows = rows.filter((row) => row.page_type === "homepage");
  for (const row of homepageRows) {
    const { data: award, error: loadError } = await supabase
      .from("shared_awards")
      .select("official_homepage")
      .eq("id", row.shared_award_id)
      .maybeSingle();
    if (loadError) throw new Error(`shared_awards load failed: ${loadError.message}`);
    if (award?.official_homepage) continue;
    const { error: updateError } = await supabase
      .from("shared_awards")
      .update({ official_homepage: row.url, updated_at: new Date().toISOString() })
      .eq("id", row.shared_award_id);
    if (updateError) throw new Error(`shared_awards homepage update failed: ${updateError.message}`);
  }

  return count;
}

function shouldImproveOneSourceAward(source) {
  if (source.last_error) return true;
  if (source.page_type !== "homepage") return true;
  if (/\.pdf($|\?)/i.test(source.url)) return true;
  return false;
}

function shouldAddOfficialHomepageSource(award, awardSources) {
  if (!award.official_homepage) return false;
  const canonicalHomepage = canonicalUrlKey(award.official_homepage);
  if (!canonicalHomepage) return false;
  return !awardSources.some((source) => canonicalUrlKey(source.url) === canonicalHomepage);
}

async function loadCatalog() {
  const [awards, sources] = await Promise.all([
    loadAll("shared_awards", "id,name,official_homepage,status,updated_at"),
    loadAll("shared_award_sources", "id,shared_award_id,url,title,page_type,last_error,confidence,source,updated_at"),
  ]);
  return {
    awards: awards.filter((award) => award.status === "active"),
    sources,
  };
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
  if (
    env.NEXT_PUBLIC_SUPABASE_URL &&
    env.SUPABASE_SERVICE_ROLE_KEY &&
    !env.NEXT_PUBLIC_SUPABASE_URL.includes("127.0.0.1")
  ) {
    return createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  const projectRef = readLinkedProjectRef();
  if (!projectRef) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or link Supabase.");
  }

  const keys = JSON.parse(
    execFileSync("npx", ["supabase", "projects", "api-keys", "--project-ref", projectRef, "--output", "json"], {
      encoding: "utf8",
      cwd: root,
    }),
  );
  const serviceRoleKey = keys.find((key) => key.name === "service_role")?.api_key;
  if (!serviceRoleKey) throw new Error(`Could not read service_role key for ${projectRef}.`);
  return createSupabaseServiceClient(`https://${projectRef}.supabase.co`, serviceRoleKey);
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

function classifyPageType(url, title) {
  const lower = `${url.toString()} ${title}`.toLowerCase();
  if (url.pathname.toLowerCase().endsWith(".pdf")) return "pdf";
  if (/(deadline|dates?|timeline|cycle)/.test(lower)) return "deadline";
  if (/(apply|application|portal|nomination|references?|recommendation|advice|guidance)/.test(lower)) {
    return "application";
  }
  if (/(eligib|who-can-apply)/.test(lower)) return "eligibility";
  if (/(requirement|criteria|materials|documents|guidelines?)/.test(lower)) return "requirements";
  if (/(faq|questions)/.test(lower)) return "faq";
  return "homepage";
}

function normalizeResultUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/g, "");
    }
    return url.toString();
  } catch {
    return "";
  }
}

function decodeDuckDuckGoUrl(value) {
  if (!value) return "";
  try {
    const absolute = value.startsWith("//") ? `https:${value}` : value;
    const url = new URL(absolute);
    const uddg = url.searchParams.get("uddg");
    return uddg || absolute;
  } catch {
    return value;
  }
}

function decodeBingUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const encoded = url.searchParams.get("u");
    if (!encoded) return value;
    const payload = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return value;
  }
}

function canonicalUrlKey(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname
      .replace(/\/index\.(html?|php|aspx?)$/i, "/")
      .replace(/\.aspx$/i, "")
      .replace(/\/+$/g, "")
      .toLowerCase();
    const search = canonicalSearchParams(url.searchParams);
    return `${hostname}${pathname || "/"}${search}`;
  } catch {
    return String(value || "").trim().toLowerCase().replace(/\/+$/g, "");
  }
}

function canonicalSearchParams(searchParams) {
  const kept = [];
  for (const [rawKey, rawValue] of searchParams.entries()) {
    const key = rawKey.toLowerCase();
    const value = rawValue.trim();
    if (!key || key.startsWith("utm_")) continue;
    if (["fbclid", "gclid", "msclkid", "mc_cid", "mc_eid", "share", "replytocom"].includes(key)) continue;
    if (["lang", "locale", "view", "campaign"].includes(key)) continue;
    if (key === "page" && (!value || value === "1")) continue;
    if (key === "s" && !value) continue;
    kept.push([key, value.toLowerCase()]);
  }

  kept.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    `${leftKey}=${leftValue}`.localeCompare(`${rightKey}=${rightValue}`),
  );
  return kept.length ? `?${kept.map(([key, value]) => `${key}=${value}`).join("&")}` : "";
}

function significantTokens(value) {
  const tokens = String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .match(/[a-z0-9]+/g) || [];
  return [...new Set(tokens.filter((token) => token.length >= 4 && !genericWords.has(token)))].slice(0, 10);
}

function exactPhraseCandidates(value) {
  const clean = normalizeText(value).toLowerCase();
  const parts = clean.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  return [clean, ...parts].map((part) => part.replace(/\s+/g, " "));
}

function cleanTitle(title, url) {
  const text = normalizeText(title);
  if (text && text.length <= 180) return text;
  if (text) return `${text.slice(0, 177)}...`;
  return url.hostname.replace(/^www\./, "");
}

function registrableDomain(hostname) {
  const parts = hostname.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function loadEnvFile(path) {
  try {
    const env = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
    }
    return env;
  } catch {
    return {};
  }
}

function readLinkedProjectRef() {
  try {
    return readFileSync(resolve(root, "supabase/.temp/project-ref"), "utf8").trim();
  } catch {
    return "";
  }
}

async function mapWithConcurrency(values, workerCount, callback) {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, workerCount) }, async () => {
    while (index < values.length) {
      const current = values[index];
      index += 1;
      await callback(current);
    }
  });
  await Promise.all(workers);
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
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
