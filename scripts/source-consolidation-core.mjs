const protectedPageTypes = new Set([
  "homepage",
  "deadline",
  "application",
  "eligibility",
  "requirements",
  "pdf",
  "faq",
]);

const genericAwardWords = new Set([
  "administration",
  "american",
  "academic",
  "akademischer",
  "association",
  "austauschdienst",
  "award",
  "awards",
  "college",
  "daad",
  "department",
  "deutscher",
  "doctoral",
  "exchange",
  "foundation",
  "fellow",
  "fellowship",
  "fellowships",
  "graduate",
  "grant",
  "grants",
  "german",
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
  "service",
  "student",
  "students",
  "university",
]);

const highIntentSignal =
  /\b(apply|application|applicant|deadline|eligib|requirement|guidelines?|instructions?|faq|nomination|portal|materials?|forms?|scholarships?|fellowships?|grants?|awards?)\b/i;

export function classifySourceForConsolidation(source = {}, award = {}, options = {}) {
  const quality = sourceQualityScore(source, award);
  const reason = strongConsolidationReason(source, award);

  if (reason) {
    return {
      action: "review_later",
      reason,
      qualityScore: quality.score,
      signals: quality.signals,
      note: "Broad, duplicate-like, or non-award page attached to an award source outline.",
    };
  }

  if (options.excess && quality.score <= Number(options.lowQualityThreshold ?? 45)) {
    return {
      action: "review_later",
      reason: "excess_low_quality_source",
      qualityScore: quality.score,
      signals: quality.signals,
      note: "Low-signal source on an award with too many open source pages.",
    };
  }

  return {
    action: "keep",
    reason: null,
    qualityScore: quality.score,
    signals: quality.signals,
    note: null,
  };
}

export function sourceQualityScore(source = {}, award = {}) {
  const signals = [];
  let score = 0;
  const parsed = safeUrl(source.url);
  const direct = directSignal(source);
  const pageType = String(source.page_type || "").toLowerCase();

  if (parsed?.protocol === "https:") {
    score += 8;
    signals.push("https");
  }
  if (protectedPageTypes.has(pageType)) {
    score += 18;
    signals.push(`page_type:${pageType}`);
  }
  if (highIntentSignal.test(direct)) {
    score += 28;
    signals.push("award_intent");
  }
  const tokenMatches = matchingAwardTokens(source, award);
  if (tokenMatches.length >= 2) {
    score += 45;
    signals.push(`award_tokens:${tokenMatches.slice(0, 4).join(",")}`);
  } else if (tokenMatches.length === 1) {
    score += 20;
    signals.push(`award_token:${tokenMatches[0]}`);
  }
  if (!String(source.last_error || "").trim()) {
    score += 8;
    signals.push("no_error");
  } else {
    score -= 10;
    signals.push("has_error");
  }
  if (parsed?.search) score -= 8;
  if (genericTitle(source.title)) score -= 18;
  if (String(pageType) === "other") score -= 6;
  if (strongConsolidationReason(source, award)) score -= 60;

  return { score, signals };
}

export function strongConsolidationReason(source = {}, award = {}) {
  const parsed = safeUrl(source.url);
  if (!parsed) return "invalid_url";

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.toLowerCase();
  const direct = directSignal(source);
  const awardSpecific = hasAwardSpecificSignal(source, award);

  if (genericListingOrSearchShape(parsed, direct)) {
    return "generic_source_shape";
  }

  if (genericTitle(source.title) && !awardSpecific && !highIntentSignal.test(direct)) {
    return "generic_navigation_source";
  }

  if (/\/university-ad\//.test(path)) return "university_ad_spillover";

  if (/\/(?:about|contact|contact-us|people|staff|faculty|alumni|meet|locations?|rooms?|spaces?|workshops?|calendar|events?|news|blog)(?:\/|\.html?|$)/.test(path) && !awardSpecific) {
    return "generic_navigation_source";
  }

  if (host.endsWith("sc.edu") && /\/study\/colleges_schools\//.test(path) && !/national_resource_center\/award_recognition_programs\/fidler_research_grant/.test(path)) {
    return "campus_program_spillover";
  }

  if (host === "equaljusticeamerica.org" && /\/index\.php\/[^/]*(school-of-law|state-initiatives|student_templates)/.test(path)) {
    return "profile_or_school_spillover";
  }

  if (host === "gfoa.org" && /\/materials\//.test(path) && !awardSpecific) {
    return "professional_material_spillover";
  }

  if ((host === "ed.gov" || host === "www2.ed.gov") && /\/about(?:\/|$)|\/about\/contact-us\/faqs/.test(path)) {
    return "generic_agency_page";
  }
  if ((host === "ed.gov" || host === "www2.ed.gov") && /\/media\/document\/s\d+/.test(path)) {
    return "grant_archive_spillover";
  }
  if ((host === "ed.gov" || host === "www2.ed.gov") && /\/grants-and-programs\//.test(path) && !awardSpecific) {
    return "broad_grants_listing_spillover";
  }

  if (host === "govinfo.gov") return "legislative_archive_spillover";

  if (host === "nsf.gov" && /\/(?:awards|policies|focus-areas|funding\/initiatives|updates-on-priorities)(?:\/|$)/.test(path) && !awardSpecific) {
    return "agency_policy_spillover";
  }

  if (host === "grants.nih.gov" && /\/(?:grants-process|grants\/policy|sites\/default\/files|grants\/how-to-apply-application-guide)\//.test(path) && !awardSpecific) {
    return "agency_policy_spillover";
  }

  if (host.endsWith("nia.nih.gov") && /\/research\/(?:dab|grants-funding\/nia-data-management)/.test(path) && !awardSpecific) {
    return "agency_research_resource_spillover";
  }

  if (host === "nasa.gov" && /\/wp-content\/uploads\//.test(path) && /\b(fiscal year|presrep|wakeup calls|telemedicine|president)\b/i.test(direct)) {
    return "archive_pdf_spillover";
  }

  if (isDaadScholarshipDatabasePdfExport(host, path)) return "duplicate_pdf_export";

  if (isBroadAcademicPdfSpillover(host, path, direct, award)) {
    return "academic_policy_pdf_spillover";
  }

  if (host === "ala.org" && /\/council_documents\//.test(path)) return "governance_pdf_spillover";

  if (host === "home.treasury.gov" && /\/(?:system\/files|services\/the-multiemployer-pension-reform-act-of-2014|policy-issues|data)\//.test(path) && !awardSpecific) {
    return "agency_policy_spillover";
  }

  if (host === "daad.de" && /\/rise\/files\//.test(path) && /\b(report|internship report|[a-z]+-[a-z]+)\b/i.test(direct)) {
    return "participant_report_spillover";
  }

  if (host.endsWith("thermofisher.com") && /\/(?:antibodies-learning-center|secondary-antibodies|protocols|application-notes)\b/.test(path) && !awardSpecific) {
    return "product_resource_spillover";
  }

  if (host === "gsa.gov" && /\/(?:reference\/freedom-of-information-act|system\/files)\//.test(path) && !awardSpecific) {
    return "agency_foia_spillover";
  }

  if (host === "180medical.com" && /\/request-free-samples/.test(path)) return "commercial_sample_spillover";

  if (host === "ciee.org" && (/^\/$/.test(path) || /\/go-abroad\/college-study-abroad(?:\/(?:locations|programs)?)?\/?$/.test(path))) {
    return "broad_directory_spillover";
  }

  if (host === "agc.org" && /\/education(?:\/|$)/.test(path) && !awardSpecific) return "professional_training_spillover";

  if (host === "getty.edu" && /\/conservation\/publications_resources\/teaching\//.test(path) && !awardSpecific) {
    return "educational_resource_spillover";
  }

  if (host === "lib.ncsu.edu" && /\/(?:spaces|workshops)\//.test(path)) return "library_service_spillover";

  if (host === "acf.gov" && /\/css\/(?:outreach-material|employers)\//.test(path)) return "agency_program_spillover";

  return null;
}

function isDaadScholarshipDatabasePdfExport(host, path) {
  return (
    /(^|\.)daad\.de$/.test(host) &&
    /\/deutschland\/stipendium\/datenbank\/[^/]+\/21148-scholarship-database\.pdf$/i.test(path)
  );
}

function isBroadAcademicPdfSpillover(host, path, direct, award) {
  if (!/\.pdf(?:$|[?#])/i.test(path)) return false;
  if (host === "static.daad.de" && matchingAwardTokens({ url: direct, title: direct, reason: direct }, award).length >= 1) {
    return false;
  }
  if (hasAwardSpecificSignal({ url: direct, title: direct, reason: direct }, award)) return false;

  return (
    (host === "static.daad.de" && /\/media\/daad_de\/pdfs_nicht_barrierefrei\//.test(path)) ||
    (/(^|\.)kmk\.org$/.test(host) && /\/(?:hochschulzugang|zab)\/|baccalaureate/i.test(path)) ||
    (host === "humboldt-foundation.de" && /\/fileadmin\/bewerben\/programme\/.*list_of_countries\.pdf$/i.test(path)) ||
    (host === "hrk.de" && /\/fileadmin\/redaktion\/hrk\/.*auslandstitel/i.test(path))
  );
}

export function hasAwardSpecificSignal(source = {}, award = {}) {
  return matchingAwardTokens(source, award).length >= 2;
}

export function matchingAwardTokens(source = {}, award = {}) {
  const tokens = distinctiveAwardTokens(award?.name || "");
  const signal = normalizeWords(directSignal(source));
  return tokens.filter((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(signal));
}

export function distinctiveAwardTokens(value) {
  return [
    ...new Set(
      String(value || "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .split(/[^a-z0-9]+/g)
        .filter((token) => token.length >= 4 && !genericAwardWords.has(token)),
    ),
  ].slice(0, 14);
}

function directSignal(source = {}) {
  return [source.url, source.title, source.display_title, source.page_type, source.reason]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function genericTitle(value) {
  const title = normalizeWords(value);
  return /^(home|homepage|about|about us|contact|contact us|resources?|more|mehr|learn more|read more|daily|email|pdf|search|search locations|student benefits|request free samples|join|ciee\.org)$/.test(
    title,
  );
}

function genericListingOrSearchShape(url, direct) {
  const path = url.pathname.toLowerCase();

  return (
    /\/(?:tag|tags|category|categories)(?:\/|$)/.test(path) ||
    /\/(?:search|search-results?|site-search|search-results-page)(?:\/|\.html?|\.aspx?|$)/.test(path) ||
    /\/(?:guidelinesearch|sitesearch|search|searchresults?)\.(?:html?|aspx?|php)$/.test(path) ||
    hasGenericSearchQuery(url, direct)
  );
}

function hasGenericSearchQuery(url, direct) {
  if (specificAwardDetailSignal(direct)) return false;

  const path = url.pathname.toLowerCase().replace(/\/+$/g, "") || "/";
  const titleSearchSignal = /\b(search results?|site search|back to search|results for)\b/i.test(direct);

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

function specificAwardDetailSignal(value) {
  return /\b(how to apply|application process|application requirements?|eligibility requirements?|program requirements?|deadline|due date|faq|frequently asked questions?)\b/i.test(
    value,
  );
}

function normalizeWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
