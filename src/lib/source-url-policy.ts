const institutionalDiscoveryHosts = new Set([
  "fellowship-finder.grad.illinois.edu",
  "onsa.asu.edu",
]);
const cmsAdminHosts = new Set(["a.cms.omniupdate.com"]);
const softwareDownloadHosts = new Set(["get.adobe.com"]);
const libAnswersHost = /(?:^|\.)libanswers\.com$/i;

const hardNonAwardPath =
  /\/(wp-login\.php|login|signin|sign-in|cart|donate|privacy|terms|terms-of-use|terms-of-service|termsofuse|jobregister)\b|\/(sign-up|signup|subscribe|newsletter)\b|\/portal\/user\/u_login\.php/i;
const careerOrProfilePath =
  /\/(?:careers?|jobs?|job|job-profile|jobprofile|profile|profiles?|employment)\/|\/(?:careers?|jobs?|job|job-profile|jobprofile|profile|profiles?|employment)(?:[?#/]|$)/i;
const paymentOrBursarPath =
  /\/(?:payment|payments|pay|billing|bursar|tuition|1098t|1098-t|tax-form|tax-forms)(?:[?#/]|$)/i;
const listingPath = /\/(news|events|calendar|tag|category|recipients?|awardees?|fellows?|past-fellows|current-fellows)\b/i;
const broadProgramSearchPath = /\/(?:find-programs?|program-search|search-programs?|programs\/search|scholarship-search|scholarships\/search|database\/search)(?:[?#/]|$)/i;
const trackingQuery = /[?&](share|replytocom|utm_|fbclid|gclid|redirect_to=)/i;
const nonMonitorableAsset = /\.(jpg|jpeg|png|gif|webp|svg|zip|ics|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/i;
const badUploadHtmlTerms = /(viagra|levitra|cialis|pharma|casino|xanax|tramadol|pills|essay-writing|payday)/i;
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

export function isInstitutionalDiscoveryUrl(value: string | null | undefined) {
  if (!value) return false;

  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return institutionalDiscoveryHosts.has(hostname);
  } catch {
    return false;
  }
}

export function isTrackableOfficialSourceUrl(value: string | null | undefined) {
  return Boolean(value) && !isInstitutionalDiscoveryUrl(value) && !isClearlyNonAwardSourceUrl(value);
}

export function isMonitorableOfficialSource(source: {
  url: string | null | undefined;
  page_type?: string | null | undefined;
}) {
  if (!source.url || isInstitutionalDiscoveryUrl(source.url)) return false;
  if (isHardBlockedOfficialSourceUrl(source.url)) return false;
  if (isClearlyNonAwardSourceUrl(source.url)) return false;
  return true;
}

export function isProtectedOfficialSourcePageType(value: string | null | undefined) {
  return protectedOfficialSourcePageTypes.has(String(value || "").toLowerCase());
}

export function isClearlyNonAwardSourceUrl(value: string | null | undefined) {
  if (!value) return false;

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const fullUrl = url.toString();
    if (!["http:", "https:"].includes(url.protocol)) return true;
    if (cmsAdminHosts.has(hostname)) return true;
    if (softwareDownloadHosts.has(hostname)) return true;
    if (phoneNumberPathSegment.test(decodeURIComponent(url.pathname))) return true;
    if (isNationalAcademiesNonAwardUrl(hostname, url)) return true;
    if (isOpenDataListingOrFacetUrl(hostname, url)) return true;
    if (isDuplicateOrBroadPdfUrl(hostname, url.pathname)) return true;
    if (isKnownSpamOrAccessUrl(hostname, url)) return true;
    if (isBroadScholarshipDatabaseListingUrl(hostname, url)) return true;
    if (hardNonAwardPath.test(url.pathname) || trackingQuery.test(fullUrl)) return true;
    if (careerOrProfilePath.test(url.pathname)) return true;
    if (paymentOrBursarPath.test(url.pathname)) return true;
    if (broadProgramSearchPath.test(url.pathname)) return true;
    if (listingPath.test(url.pathname)) return true;
    return nonMonitorableAsset.test(url.pathname);
  } catch {
    return true;
  }
}

export function isHardBlockedOfficialSourceUrl(value: string | null | undefined) {
  if (!value) return false;

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const fullUrl = url.toString();
    if (!["http:", "https:"].includes(url.protocol)) return true;
    if (cmsAdminHosts.has(hostname)) return true;
    if (softwareDownloadHosts.has(hostname)) return true;
    if (phoneNumberPathSegment.test(decodeURIComponent(url.pathname))) return true;
    if (isNationalAcademiesNonAwardUrl(hostname, url)) return true;
    if (isOpenDataListingOrFacetUrl(hostname, url)) return true;
    if (isDuplicateOrBroadPdfUrl(hostname, url.pathname)) return true;
    if (isKnownSpamOrAccessUrl(hostname, url)) return true;
    if (isBroadScholarshipDatabaseListingUrl(hostname, url)) return true;
    return (
      hardNonAwardPath.test(url.pathname) ||
      trackingQuery.test(fullUrl) ||
      careerOrProfilePath.test(url.pathname) ||
      paymentOrBursarPath.test(url.pathname) ||
      broadProgramSearchPath.test(url.pathname) ||
      listingPath.test(url.pathname)
    );
  } catch {
    return true;
  }
}

function isKnownSpamOrAccessUrl(hostname: string, url: URL) {
  const path = decodeURIComponent(url.pathname || "");
  const fullUrl = decodeURIComponent(url.toString());

  if (/\/wp-content\/uploads\/\d{4}\/\d{2}\/[^/]+\.html?$/i.test(path) && badUploadHtmlTerms.test(fullUrl)) {
    return true;
  }

  if (hostname === "ask.loc.gov" && /(?:security|question|access|account|login|password)/i.test(fullUrl)) {
    return true;
  }

  if (libAnswersHost.test(hostname) && /(?:security|question|access|account|login|password)/i.test(fullUrl)) {
    return true;
  }

  return false;
}

function isBroadScholarshipDatabaseListingUrl(hostname: string, url: URL) {
  const path = url.pathname.toLowerCase();
  const fullUrl = url.toString().toLowerCase();
  const looksLikeScholarshipDatabase =
    /(?:scholarship|fellowship|grant).*(?:database|search|finder|directory)|(?:database|search|finder|directory).*(?:scholarship|fellowship|grant)/i.test(
      `${hostname} ${path}`,
    );

  if (!looksLikeScholarshipDatabase) return false;
  if (url.searchParams.has("detail") || url.searchParams.has("id") || url.searchParams.has("program_id")) {
    return false;
  }

  return (
    /[?&](?:q|query|keyword|search|status|origin|level|subject|category|page|sort)=/i.test(fullUrl) ||
    /\/(?:search|results|listing|list|directory|database)(?:\/|$)/i.test(path)
  );
}

function isDuplicateOrBroadPdfUrl(hostname: string, pathname: string) {
  return (
    /(^|\.)daad\.de$/.test(hostname) &&
    /\/deutschland\/stipendium\/datenbank\/[^/]+\/21148-scholarship-database\.pdf$/i.test(pathname)
  ) || (
    hostname === "studieren-weltweit.de" &&
    /\/content\/uploads\/\d{4}\/\d{2}\/mit-stipendium-ins-ausland\.pdf$/i.test(pathname)
  );
}

function isNationalAcademiesNonAwardUrl(hostname: string, url: URL) {
  const path = url.pathname.toLowerCase().replace(/\/+$/g, "") || "/";

  if (hostname === "www8.nationalacademies.org") {
    return /^\/pa\/(?:managerequest|feedback)\.aspx$/.test(path);
  }

  if (hostname !== "nationalacademies.org") return false;

  if (
    path === "/" ||
    /^\/(?:current-operating-status|members|myacademies-accounts|advancing-a-robust-us-economy)(?:\/|$)/.test(path)
  ) {
    return true;
  }

  return /^\/projects(?:\/|$)/.test(path);
}

function isOpenDataListingOrFacetUrl(hostname: string, url: URL) {
  if (!/(^|\.)open\.alberta\.ca$/.test(hostname)) return false;
  if (/^\/(?:documentation|licence|policy|suggest|dataset|publications)?\/?$/i.test(url.pathname)) {
    return true;
  }
  if (/^\/opendata(?:\/|$)/i.test(url.pathname)) return true;
  if (/^\/dataset\/[^/]+\/resource\/[^/]+\/download(?:\/|$)/i.test(url.pathname)) return true;
  if (!/^\/(?:publications|dataset)\/?$/i.test(url.pathname)) return false;

  const listingKeys = new Set([
    "audience",
    "dataset_type",
    "organization",
    "page",
    "pubtype",
    "q",
    "res_format",
    "rows",
    "sort",
    "start",
    "tags",
    "topic",
  ]);

  for (const key of url.searchParams.keys()) {
    if (listingKeys.has(key.toLowerCase())) return true;
  }

  return false;
}

export function filterTrackableOfficialSources<T extends { url: string }>(sources: T[]) {
  const byCanonicalUrl = new Map<string, T>();

  for (const source of sources) {
    if (!isTrackableOfficialSourceUrl(source.url)) continue;

    const key = canonicalSourceUrlKey(source.url);
    const existing = byCanonicalUrl.get(key);
    if (!existing || sourcePreferenceScore(source.url) > sourcePreferenceScore(existing.url)) {
      byCanonicalUrl.set(key, source);
    }
  }

  return [...byCanonicalUrl.values()];
}

export function displayHomepageForAward<T extends { url: string; page_type?: string | null }>(
  homepage: string | null,
  sources: T[],
) {
  if (isTrackableOfficialSourceUrl(homepage)) return homepage;

  const homepageSource = sources.find(
    (source) => source.page_type === "homepage" && isTrackableOfficialSourceUrl(source.url),
  );
  if (homepageSource) return homepageSource.url;

  return sources.find((source) => isTrackableOfficialSourceUrl(source.url))?.url || null;
}

export function canonicalSourceUrlKey(value: string) {
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
    return value.trim().toLowerCase().replace(/\/+$/g, "");
  }
}

function canonicalSearchParams(searchParams: URLSearchParams) {
  const kept: Array<[string, string]> = [];

  for (const [rawKey, rawValue] of searchParams.entries()) {
    const key = rawKey.toLowerCase();
    const value = rawValue.trim();
    if (!key || key.startsWith("utm_")) continue;
    if (["fbclid", "gclid", "msclkid", "mc_cid", "mc_eid", "share", "replytocom"].includes(key)) continue;
    if (["lang", "locale", "view", "campaign", "sort"].includes(key)) continue;
    if (key === "page" && (!value || value === "1")) continue;
    if (key === "s" && !value) continue;
    kept.push([key, value.toLowerCase()]);
  }

  // Entries arrive decoded: encode each kept pair into one unambiguous string
  // and use it for both ordering and serialization, so a value containing
  // "&" or "=" never collides with separate parameters and the same
  // parameters in another order never yield a different key.
  const pairs = kept
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return pairs.length ? `?${pairs.join("&")}` : "";
}

function sourcePreferenceScore(value: string) {
  try {
    const url = new URL(value);
    let score = url.protocol === "https:" ? 2 : 1;
    if (!url.search) {
      score += 20;
    } else {
      score -= 20;
    }
    if (/%0a|%0d/i.test(url.search)) score -= 50;
    return score;
  } catch {
    return 0;
  }
}
