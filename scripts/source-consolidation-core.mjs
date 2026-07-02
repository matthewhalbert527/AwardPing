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
  "earth",
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
  "nasa",
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
  "space",
  "student",
  "students",
  "technology",
  "university",
]);

const highIntentSignal =
  /\b(apply|application|applicant|deadline|eligib|requirement|guidelines?|instructions?|faq|nomination|portal|materials?|forms?|scholarships?|fellowships?|grants?|awards?)\b/i;

const sharedProgramCollectionRoots = new Set([
  "award",
  "awards",
  "educational-support",
  "education-support",
  "fellowship",
  "fellowships",
  "funding",
  "grant",
  "grants",
  "opportunities",
  "our-work",
  "program",
  "programs",
  "scholarship",
  "scholarships",
  "student-aid",
]);

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

  if (isKnownSiblingAwardSpillover(path, directSourceSignal(source), award)) {
    return "same_host_sibling_program_spillover";
  }

  if (isSameHostSiblingProgramSpillover(host, path, directSourceSignal(source), award)) {
    return "same_host_sibling_program_spillover";
  }

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

  if (isNspiresRosesSpillover(host, path, directSourceSignal(source), award)) {
    return "nspires_roses_spillover";
  }

  if (isDaadScholarshipDatabasePdfExport(host, path)) return "duplicate_pdf_export";

  if (isBroadAcademicPdfSpillover(host, path, direct, award)) {
    return "academic_policy_pdf_spillover";
  }

  if (isBroadScholarshipBrochurePdf(host, path)) return "broad_scholarship_brochure";

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

function isNspiresRosesSpillover(host, path, direct, award) {
  if (host !== "nspires.nasaprs.com") return false;
  if (!/^\/external\/(?:viewrepositorydocument|solicitations\/summary(?:!init)?\.do)/i.test(path)) {
    return false;
  }
  const awardTokens = distinctiveAwardTokens(award?.name || "");
  const tokenMatches = matchingAwardTokens({ url: direct, title: direct, display_title: direct }, award);
  if (tokenMatches.length >= Math.min(2, awardTokens.length)) return false;
  if (awardTokens.length >= 2) return true;

  const signal = normalizeWords(direct);
  if (
    /\b(?:complete\s+roses|full\s+roses|roses\s?\d{2,4}|summary\s+of\s+solicitation|due\s+dates?|table\s+[23]|guidebook\s+for\s+proposers)\b/i.test(
      signal,
    )
  ) {
    return true;
  }
  if (
    /\b(?:not\s+solicited|program\s+overview|research\s+program\s+overview|research\s+announcement|announcement\s+for\s+proposals|proposer'?s?\s+telecon)\b/i.test(
      signal,
    )
  ) {
    return true;
  }
  if (/^\/external\/solicitations\/summary(?:!init)?\.do/i.test(path)) return true;
  return /^[a-f]\s?\d{1,2}\b/i.test(signal);
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

function isBroadScholarshipBrochurePdf(host, path) {
  return (
    host === "studieren-weltweit.de" &&
    /\/content\/uploads\/\d{4}\/\d{2}\/mit-stipendium-ins-ausland\.pdf$/i.test(path)
  );
}

export function hasAwardSpecificSignal(source = {}, award = {}) {
  return matchingAwardTokens(source, award).length >= 2;
}

export function matchingAwardTokens(source = {}, award = {}) {
  const tokens = distinctiveAwardTokens(award?.name || "");
  const signal = normalizeWords(directSourceSignal(source));
  return tokens.filter((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(signal));
}

export function distinctiveAwardTokens(value) {
  const prepared = joinDottedAcronyms(String(value || ""));
  const acronymTokens = new Set(
    (prepared.match(/\b[A-Z0-9]{2,}\b/g) || [])
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 2 && !genericAwardWords.has(token)),
  );

  return [
    ...new Set(
      prepared
        .toLowerCase()
        .replace(/&/g, " and ")
        .split(/[^a-z0-9]+/g)
        .filter((token) => (token.length >= 4 || acronymTokens.has(token)) && !genericAwardWords.has(token)),
    ),
  ].slice(0, 14);
}

function directSignal(source = {}) {
  return [source.url, source.title, source.display_title, source.page_description, source.page_type, source.reason]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function directSourceSignal(source = {}) {
  return [source.url, source.title, source.display_title, source.page_description, source.page_type]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isSameHostSiblingProgramSpillover(host, path, direct, award) {
  const homepage = safeUrl(award?.official_homepage);
  if (!homepage) return false;

  const homepageHost = homepage.hostname.toLowerCase().replace(/^www\./, "");
  if (homepageHost !== host) return false;

  const sourcePath = normalizePath(path);
  const homepagePath = normalizePath(homepage.pathname);
  if (!sourcePath || !homepagePath || homepagePath === "/") return false;
  if (sourcePath === homepagePath || sourcePath.startsWith(`${homepagePath}/`)) return false;

  const awardRootPath = awardRootPathFromHomepage(homepagePath, award?.name || "");
  if (awardRootPath && (sourcePath === awardRootPath || sourcePath.startsWith(`${awardRootPath}/`))) {
    return false;
  }

  if (hasAwardNamePathPhraseMatch(sourcePath, award?.name || "")) return false;

  const tokens = siblingSpecificAwardTokens(award?.name || "", homepagePath, host);
  if (tokens.length === 0) return false;

  const sourceSignal = normalizeWords(`${direct} ${sourcePath}`);
  const matchingTokens = tokens.filter((token) => tokenAppears(sourceSignal, token));
  if (matchingTokens.length >= Math.min(2, tokens.length)) return false;
  if (tokens.length === 1 && matchingTokens.length === 1) return false;

  if (hasSharedProgramCollectionRoot(homepagePath, sourcePath)) return true;
  if (hasShallowSiblingAwardPageSignal(sourcePath, sourceSignal)) return true;

  return (
    /^\/(?:programs?|awards?|scholarships?|fellowships?|grants?|funding|our-work)(?:\/|$)/.test(sourcePath) &&
    hasProgramLikePathSignal(sourcePath)
  );
}

function isKnownSiblingAwardSpillover(path, direct, award) {
  const awardSignal = normalizeWords(`${award?.name || ""} ${award?.official_homepage || ""}`);
  const rawSourceSignal = `${direct} ${path} ${safeDecode(`${direct} ${path}`)}`;
  const sourceSignal = normalizeWords(rawSourceSignal);
  const compactSourceSignal = sourceSignal.replace(/\s+/g, "");

  if (
    tokenAppears(awardSignal, "peo") &&
    tokenAppears(awardSignal, "scholar") &&
    tokenAppears(awardSignal, "awards")
  ) {
    const currentBranch = /\b(?:scholar awards?|scholar-awards)\b/i.test(sourceSignal);
    const siblingBranch =
      /\b(?:star scholarship|star student application|star procedures|international peace scholarship|ips application calendar|ips policies|program for continuing education|continuing education|pce candidate|pce income|pce application|pce policies)\b/i.test(
        sourceSignal,
      ) ||
      /(?:starscholarship|starprocedures|ipsapplication|ipspolicies|pcecandidate|pceincome|pcepolicies)/i.test(
        compactSourceSignal,
      );

    if (siblingBranch && !currentBranch) return true;
  }

  return false;
}

const awardPhraseOrgStopWords = new Set([
  "american",
  "association",
  "board",
  "canada",
  "center",
  "centre",
  "college",
  "committee",
  "council",
  "department",
  "division",
  "foundation",
  "institute",
  "international",
  "national",
  "office",
  "organization",
  "society",
  "university",
]);

function hasAwardNamePathPhraseMatch(sourcePath, awardName) {
  const segments = pathSegments(sourcePath).map((segment) => slugifyAwardPhrase(segment)).filter(Boolean);
  if (!segments.length) return false;

  for (const candidate of awardNamePathPhrases(awardName)) {
    if (!candidate.slug) continue;
    if (segments.includes(candidate.slug)) return true;
    if (sourcePath.includes(`/${candidate.slug}/`) || sourcePath.endsWith(`/${candidate.slug}`)) return true;

    if (candidate.tokens.length <= 3) {
      const tokenSegments = candidate.tokens.filter((token) => token.length >= 4);
      if (tokenSegments.some((token) => segments.includes(token))) return true;
    }
  }

  return false;
}

function awardNamePathPhrases(awardName) {
  const prepared = joinDottedAcronyms(String(awardName || ""));
  const parts = prepared
    .split(/\s+(?:-|–|—)\s+|:\s+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const tail = parts.at(-1) || prepared;
  const phrases = [tail, prepared];

  return phrases
    .map((phrase) => {
      const tokens = normalizeWords(phrase)
        .split(" ")
        .filter((token) => token.length >= 2 && !awardPhraseOrgStopWords.has(token));
      return {
        tokens,
        slug: tokens.join("-"),
      };
    })
    .filter((candidate, index, all) => candidate.slug && all.findIndex((item) => item.slug === candidate.slug) === index);
}

function slugifyAwardPhrase(value) {
  return normalizeWords(value)
    .split(" ")
    .filter(Boolean)
    .join("-");
}

function awardRootPathFromHomepage(homepagePath, awardName) {
  const segments = pathSegments(homepagePath);
  if (!segments.length) return null;

  const tokens = siblingSpecificAwardTokens(awardName, homepagePath, "");
  const matchingIndex = segments.findIndex((segment) => {
    const signal = normalizeWords(segment);
    return tokens.some((token) => tokenAppears(signal, token));
  });

  if (matchingIndex !== -1) {
    return `/${segments.slice(0, matchingIndex + 1).join("/")}`;
  }

  if (segments.length === 1) return `/${segments[0]}`;
  return null;
}

function siblingSpecificAwardTokens(awardName, homepagePath, host) {
  const hostTokens = new Set(normalizeWords(host).split(" ").filter(Boolean));
  const homepageSignal = normalizeWords(`${awardName} ${homepagePath}`);
  return distinctiveAwardTokens(awardName)
    .filter((token) => !siblingGenericWords.has(token))
    .filter((token) => !hostTokens.has(token))
    .filter((token) => tokenAppears(homepageSignal, token));
}

const siblingGenericWords = new Set([
  ...genericAwardWords,
  "about",
  "apply",
  "application",
  "canada",
  "canadian",
  "college",
  "competition",
  "details",
  "education",
  "instructions",
  "nomination",
  "online",
  "overview",
  "policy",
  "primary",
  "school",
  "scholarship",
  "society",
  "state",
  "states",
  "traditional",
  "united",
]);

function hasSharedProgramCollectionRoot(homepagePath, sourcePath) {
  const homepageSegments = pathSegments(homepagePath);
  const sourceSegments = pathSegments(sourcePath);
  if (!homepageSegments.length || !sourceSegments.length) return false;
  if (homepageSegments[0] !== sourceSegments[0]) return false;

  if (
    sharedProgramCollectionRoots.has(homepageSegments[0])
  ) {
    if (homepageSegments.length === 1) return true;
    return sourceSegments.length > 1 && homepageSegments[1] !== sourceSegments[1] && hasProgramLikePathSignal(sourcePath);
  }

  return homepageSegments.length > 1 && sourceSegments.length > 1 && homepageSegments[1] === sourceSegments[1];
}

function hasProgramLikePathSignal(path) {
  return /\/(?:programs?|awards?|scholarships?|fellowships?|grants?|funding|support|apply|application|how-to-apply|eligibility|deadline|deadlines|nomination|documents?|uploads?)(?:\/|$)|(?:^|[-_/])(?:award|awards|scholarship|scholarships|fellowship|fellowships|grant|grants|program|programs)(?:[-_/]|$)/.test(
    path,
  );
}

function hasShallowSiblingAwardPageSignal(path, signal) {
  const segments = pathSegments(path);
  if (segments.length > 1) return false;
  if (!/[_-]/.test(segments[0] || "")) return false;
  return /\b(?:research chair|distinguished visitor|traditional scholar|killam|arctic initiative|entrepreneurship|visiting chair|student awards?)\b/i.test(
    signal,
  );
}

function pathSegments(value) {
  return normalizePath(value)
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function normalizePath(value) {
  const clean = String(value || "").trim().toLowerCase().replace(/\/+$/g, "");
  return clean || "/";
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
  return joinDottedAcronyms(String(value || ""))
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function joinDottedAcronyms(value) {
  return String(value || "").replace(/\b(?:[A-Za-z]\.){2,}[A-Za-z]?\.?/g, (match) => match.replace(/\./g, ""));
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function tokenAppears(signal, token) {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(signal);
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
