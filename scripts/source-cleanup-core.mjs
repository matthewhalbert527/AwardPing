export const cleanupActions = {
  noAction: "no_action",
  safeToRemove: "safe_to_remove",
  needsReplacement: "needs_replacement",
  keepButBlocked: "keep_but_blocked",
};

const institutionalDiscoveryHosts = new Set([
  "fellowship-finder.grad.illinois.edu",
  "onsa.asu.edu",
]);

const cmsAdminHosts = new Set(["a.cms.omniupdate.com"]);

const hardNonAwardPath =
  /\/(wp-login\.php|login|signin|sign-in|cart|donate|privacy|terms|terms-of-use|terms-of-service|termsofuse|jobregister)\b|\/(sign-up|signup|subscribe|newsletter)\b|\/portal\/user\/u_login\.php/i;
const listingPath = /\/(news|events|calendar|tag|category)\b/i;
const genericListingOrSearchPath =
  /\/(?:tag|tags|category|categories)(?:\/|$)|\/(?:search|search-results?|site-search|search-results-page)(?:\/|\.html?|\.aspx?|$)|\/(?:guidelinesearch|sitesearch|search|searchresults?)\.(?:html?|aspx?|php)$/i;
const trackingQuery = /[?&](share|replytocom|utm_|fbclid|gclid|redirect_to=)/i;
const nonMonitorableAsset = /\.(jpg|jpeg|png|gif|webp|svg|zip|ics|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/i;
const boilerplatePdfSource =
  /\b(login instructions?|log in|sign in|conflict of interest|coi|code of conduct|privacy policy|terms of use|bylaws?|annual report|tax form|form 990|media kit|press kit|brand guidelines?|sponsorship prospectus|advertising|invoice|receipt)\b/i;
const awardRelatedText = /(scholar|fellow|award|grant|program|apply|application|deadline|eligib)/i;
const specificAwardDetailText =
  /\b(how to apply|application process|application requirements?|eligibility requirements?|program requirements?|deadline|due date|faq|frequently asked questions?)\b/i;
const protectedOfficialSourcePageTypes = new Set([
  "homepage",
  "deadline",
  "application",
  "eligibility",
  "requirements",
  "pdf",
  "faq",
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
  "student",
  "students",
  "university",
]);

export const defaultPriorityAwardNames = [
  "Truman Scholarship",
  "Udall Scholarship",
  "Goldwater Scholarship",
  "NSF Graduate Research Fellowship Program",
  "Fulbright U.S. Student Program",
  "Rhodes Scholarship",
  "Marshall Scholarship",
  "Mitchell Scholarship",
  "Gates Cambridge Scholarship",
  "Knight-Hennessy Scholars",
  "Schwarzman Scholars",
  "Boren Awards",
  "Gilman Scholarship",
  "Critical Language Scholarship",
  "Pickering Fellowship",
  "Rangel Fellowship",
  "Payne Fellowship",
  "Hollings Scholarship",
  "Beinecke Scholarship",
  "Soros Fellowship for New Americans",
];

export function buildPostCrawlCleanupModel(input) {
  const awards = input.awards || [];
  const sources = input.sources || [];
  const awardsById = new Map(awards.map((award) => [award.id, award]));
  const sourcesByAwardId = groupBy(sources, (source) => source.shared_award_id);
  const duplicateLoserIds = findDuplicateLoserIds(sources);

  const usefulSourceCountsByAwardId = new Map();
  const usefulSourcesByAwardId = new Map();
  for (const award of awards) {
    const awardSources = sourcesByAwardId.get(award.id) || [];
    const usefulSources = awardSources.filter((source) =>
      isUsefulOfficialSource(source, award, duplicateLoserIds),
    );
    usefulSourcesByAwardId.set(award.id, usefulSources);
    usefulSourceCountsByAwardId.set(award.id, usefulSources.length);
  }

  const sourceRows = sources.map((source) => {
    const award = awardsById.get(source.shared_award_id) || null;
    const usefulCount = usefulSourceCountsByAwardId.get(source.shared_award_id) || 0;
    const replacement = bestReplacementForSource(source, usefulSourcesByAwardId.get(source.shared_award_id) || []);
    return {
      source,
      award,
      failureBucket: sourceFailureBucket(source.last_error),
      ...classifySourceCleanup(source, {
        award,
        duplicateLoserIds,
        usefulCount,
        replacement,
      }),
      replacement,
    };
  });

  return {
    awards,
    sources,
    sourceRows,
    actionCounts: countBy(sourceRows, (row) => row.action),
    failureBuckets: countBy(
      sourceRows.filter((row) => row.failureBucket !== "none"),
      (row) => row.failureBucket,
    ),
    lowCoverageAwards: buildLowCoverageAwards({
      awards,
      sourcesByAwardId,
      usefulSourcesByAwardId,
      trackedCountsByAwardId: input.trackedCountsByAwardId,
      updateCountsByAwardId: input.updateCountsByAwardId,
      priorityAwardNames: input.priorityAwardNames || defaultPriorityAwardNames,
    }),
  };
}

export function classifySourceCleanup(source, context = {}) {
  const award = context.award || null;
  const usefulCount = Number(context.usefulCount || 0);
  const duplicateLoserIds = context.duplicateLoserIds || new Set();
  const failureBucket = sourceFailureBucket(source.last_error);

  if (duplicateLoserIds.has(source.id)) {
    return {
      action: cleanupActions.safeToRemove,
      reason: "duplicate_source",
    };
  }

  const policyReason = nonAwardReason(source.url, source.title);
  if (policyReason) {
    return {
      action: cleanupActions.safeToRemove,
      reason: policyReason,
    };
  }

  if (award && isBroadRootAgencyHomepage(source.url, award.name)) {
    return {
      action: usefulCount > 0 ? cleanupActions.safeToRemove : cleanupActions.needsReplacement,
      reason: "broad_root_agency_homepage",
    };
  }

  if (isDeadFailureBucket(failureBucket)) {
    return {
      action: usefulCount > 0 ? cleanupActions.safeToRemove : cleanupActions.needsReplacement,
      reason: failureBucket,
    };
  }

  if (isBlockedFailureBucket(failureBucket)) {
    return {
      action: cleanupActions.keepButBlocked,
      reason: failureBucket,
    };
  }

  return {
    action: cleanupActions.noAction,
    reason: "healthy_or_unchecked",
  };
}

export function sourceFailureBucket(error) {
  const text = String(error || "").trim();
  if (!text) return "none";
  if (/HTTP 403\b/i.test(text)) return "403_blocked";
  if (/HTTP 404\b/i.test(text)) return "404_gone";
  if (/HTTP 410\b/i.test(text)) return "410_gone";
  if (/HTTP 429\b/i.test(text)) return "429_rate_limited";
  if (/HTTP 405\b/i.test(text)) return "405_method_blocked";
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(text)) return "dead_dns";
  if (/No readable text/i.test(text)) return "no_readable_text";
  if (/timeout|timed out|AbortError/i.test(text)) return "timeout";
  if (/fetch failed|socket|other side closed|session has been destroyed/i.test(text)) return "fetch_failed";
  return "other_failure";
}

export function isUsefulOfficialSource(source, award, duplicateLoserIds = new Set()) {
  if (!source?.url) return false;
  if (duplicateLoserIds.has(source.id)) return false;
  if (nonAwardReason(source.url, source.title, source.page_type)) return false;
  if (award && isBroadRootAgencyHomepage(source.url, award.name)) return false;
  return !isDeadFailureBucket(sourceFailureBucket(source.last_error));
}

export function nonAwardReason(value, title = "", pageType = null) {
  if (!value) return "invalid_url";

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const full = url.toString();
    const lower = `${title} ${full}`.toLowerCase();
    if (institutionalDiscoveryHosts.has(host)) return "institutional_discovery_host";
    if (cmsAdminHosts.has(host)) return "cms_admin_host";
    if (hardNonAwardPath.test(url.pathname)) return "generic_non_award_path";
    if (isDaadScholarshipDatabasePdfExport(host, url.pathname)) return "duplicate_pdf_export";
    if (
      genericListingOrSearchPath.test(url.pathname) ||
      hasGenericSearchQuery(url, lower)
    ) {
      return "generic_source_shape";
    }
    if (trackingQuery.test(full)) return "tracking_or_redirect_query";
    if (String(pageType || "").toLowerCase() === "pdf" && boilerplatePdfSource.test(lower)) return "boilerplate_pdf";
    if (protectedOfficialSourcePageTypes.has(String(pageType || "").toLowerCase())) return null;
    if (listingPath.test(url.pathname) && !awardRelatedText.test(lower)) return "generic_listing_path";
    if (nonMonitorableAsset.test(url.pathname)) return "non_monitorable_asset";
    return null;
  } catch {
    return "invalid_url";
  }
}

function isDaadScholarshipDatabasePdfExport(host, path) {
  return (
    /(^|\.)daad\.de$/.test(host) &&
    /\/deutschland\/stipendium\/datenbank\/[^/]+\/21148-scholarship-database\.pdf$/i.test(path)
  );
}

export function isBroadRootAgencyHomepage(value, awardName = "") {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/g, "");
    if (path || url.search) return false;
    if (!host.endsWith(".gov")) return false;

    const programTokens = programTokensForAward(awardName);
    return programTokens.length >= 2;
  } catch {
    return false;
  }
}

export function canonicalSourceUrlKey(value) {
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

export function findDuplicateLoserIds(sources) {
  const grouped = groupBy(sources, (source) => `${source.shared_award_id}\n${canonicalSourceUrlKey(source.url)}`);
  const loserIds = new Set();

  for (const values of grouped.values()) {
    if (values.length < 2) continue;
    const sorted = [...values].sort((left, right) => sourcePreferenceScore(right) - sourcePreferenceScore(left));
    for (const remove of sorted.slice(1)) {
      if (remove.id) loserIds.add(remove.id);
    }
  }

  return loserIds;
}

export function sourcePreferenceScore(source) {
  let score = 0;
  try {
    const url = new URL(source.url);
    if (url.protocol === "https:") score += 10;
    if (source.page_type === "homepage") score += 8;
    score += Number(source.confidence || 0);
    if (!url.search) {
      score += 20;
    } else {
      score -= 20;
    }
    if (/%0a|%0d/i.test(url.search)) score -= 50;
    if (source.last_error) score -= 5;
  } catch {
    score -= 20;
  }
  return score;
}

export function cleanupActionLabel(action) {
  if (action === cleanupActions.safeToRemove) return "Safe to remove";
  if (action === cleanupActions.needsReplacement) return "Needs replacement";
  if (action === cleanupActions.keepButBlocked) return "Keep but blocked";
  return "No action";
}

export function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function mapCountValue(counts, key) {
  if (!counts) return 0;
  if (counts instanceof Map) return counts.get(key) || 0;
  return counts[key] || 0;
}

function buildLowCoverageAwards(input) {
  const priorityNames = new Set(
    (input.priorityAwardNames || []).map((name) => normalizeAwardName(name)),
  );

  return input.awards
    .map((award) => {
      const sources = input.sourcesByAwardId.get(award.id) || [];
      const usefulSources = input.usefulSourcesByAwardId.get(award.id) || [];
      const trackedCount = mapCountValue(input.trackedCountsByAwardId, award.id);
      const updateCount = mapCountValue(input.updateCountsByAwardId, award.id);
      const usefulSourceCount = usefulSources.length;
      const priorityScore =
        (priorityNames.has(normalizeAwardName(award.name)) ? 1000 : 0) +
        (trackedCount > 0 ? 500 : 0) +
        (updateCount > 0 ? 200 : 0) +
        (usefulSourceCount === 0 ? 100 : usefulSourceCount === 1 ? 50 : 0);

      return {
        awardId: award.id,
        awardName: award.name,
        officialHomepage: award.official_homepage || null,
        sourceCount: sources.length,
        usefulSourceCount,
        trackedCount,
        updateCount,
        priorityScore,
        usefulSources: usefulSources.map((source) => ({
          id: source.id,
          title: source.title,
          url: source.url,
          pageType: source.page_type,
          lastError: source.last_error,
        })),
      };
    })
    .filter((award) => award.usefulSourceCount <= 1)
    .sort((left, right) => right.priorityScore - left.priorityScore || left.awardName.localeCompare(right.awardName));
}

function bestReplacementForSource(source, usefulSources) {
  return [...usefulSources]
    .filter((candidate) => candidate.id !== source.id)
    .sort((left, right) => sourcePreferenceScore(right) - sourcePreferenceScore(left))[0] || null;
}

function isDeadFailureBucket(bucket) {
  return ["404_gone", "410_gone", "dead_dns"].includes(bucket);
}

function isBlockedFailureBucket(bucket) {
  return [
    "403_blocked",
    "405_method_blocked",
    "429_rate_limited",
    "no_readable_text",
    "timeout",
    "fetch_failed",
    "other_failure",
  ].includes(bucket);
}

function programTokensForAward(awardName) {
  const parts = String(awardName || "")
    .split(/\s+-\s+|\s+\/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const programName = parts.slice(1).join(" ") || awardName;
  return significantTokens(programName);
}

function significantTokens(value) {
  const tokens =
    String(value || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .match(/[a-z0-9]+/g) || [];
  return [...new Set(tokens.filter((token) => token.length >= 4 && !genericWords.has(token)))].slice(0, 10);
}

function normalizeAwardName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function hasGenericSearchQuery(url, lowerSignal) {
  if (specificAwardDetailText.test(lowerSignal)) return false;

  const path = url.pathname.toLowerCase().replace(/\/+$/g, "") || "/";
  const titleSearchSignal = /\b(search results?|site search|back to search|results for)\b/i.test(
    lowerSignal,
  );

  for (const [rawKey, rawValue] of url.searchParams.entries()) {
    const key = rawKey.toLowerCase();
    const value = String(rawValue || "").trim();
    if (!value) continue;
    if (["search", "keyword", "keywords", "keys", "search_api_fulltext"].includes(key)) return true;
    if (key === "q" && (titleSearchSignal || path === "/" || /\/(?:search|site-search|search-results?)$/.test(path))) {
      return true;
    }
    if (key === "s" && (titleSearchSignal || path === "/" || path === "/index.php")) return true;
    if (key === "query" && titleSearchSignal) return true;
  }

  return false;
}

function countBy(values, getKey) {
  const counts = {};
  for (const value of values) {
    const key = getKey(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function groupBy(values, getKey) {
  const groups = new Map();
  for (const value of values) {
    const key = getKey(value);
    groups.set(key, [...(groups.get(key) || []), value]);
  }
  return groups;
}
