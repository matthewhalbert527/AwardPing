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
  return isProtectedOfficialSourcePageType(source.page_type) || !isClearlyNonAwardSourceUrl(source.url);
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
    if (phoneNumberPathSegment.test(decodeURIComponent(url.pathname))) return true;
    if (isDuplicateOrBroadPdfUrl(hostname, url.pathname)) return true;
    if (hardNonAwardPath.test(url.pathname) || trackingQuery.test(fullUrl)) return true;
    if (listingPath.test(url.pathname) && !awardRelatedText.test(fullUrl)) return true;
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
    if (phoneNumberPathSegment.test(decodeURIComponent(url.pathname))) return true;
    if (isDuplicateOrBroadPdfUrl(hostname, url.pathname)) return true;
    return hardNonAwardPath.test(url.pathname) || trackingQuery.test(fullUrl);
  } catch {
    return true;
  }
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
