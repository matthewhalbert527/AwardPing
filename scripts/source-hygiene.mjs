export function classifySourceHygiene(sourceLike = {}, failure = {}) {
  const url = String(sourceLike.url || sourceLike.source_url || "");
  const title = String(sourceLike.display_title || sourceLike.title || sourceLike.source_title || "");
  const awardName = String(sourceLike.award_name || sourceLike.awardName || "");
  const reason = String(sourceLike.reason || "");
  const pageType = String(sourceLike.page_type || "");
  const failureType = String(failure.failure_type || failure.failureType || "");
  const message = String(failure.message || failure.error_message || failure.last_error || "");
  const statusCode = Number(failure.status_code || failure.statusCode || 0) || null;
  const directHaystack = [url, title, pageType].filter(Boolean).join(" ").toLowerCase();
  const haystack = [url, title, awardName, reason, pageType, failureType, message]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const parsed = safeUrl(url);
  const host = parsed?.hostname.replace(/^www\./i, "").toLowerCase() || "";
  const path = parsed?.pathname.toLowerCase() || "";

  if (!url || !parsed) {
    return review("invalid_url", "Invalid or missing URL");
  }

  if (isSocialOrShareUrl(host, path, haystack)) {
    return review("social_or_share_link", "Social/share URL is not a monitorable award source");
  }

  if (isMediaOrArchiveUrl(path)) {
    return review("media_or_archive_file", "Media/archive file is not useful for daily award monitoring");
  }

  if (isRecursiveOrCyclicUrl(path)) {
    return review("recursive_or_cyclic_url", "URL repeats the same path segment and is likely crawler recursion");
  }

  if (isGenericListingOrSearchShape(parsed, directHaystack)) {
    return review("generic_source_shape", "Generic listing or search page is not specific enough for award monitoring");
  }

  if (isDuplicatePdfExportUrl(host, path)) {
    return review("duplicate_pdf_export", "Synthetic PDF export duplicates the canonical award database page");
  }

  if (isBroadAcademicPdfSpillover(host, path, [url, title, reason].join(" "), awardName)) {
    return review(
      "cross_program_source",
      "Broad academic policy or support PDF is not specific enough for this award",
    );
  }

  if (isBroadScholarshipBrochurePdf(host, path)) {
    return review("cross_program_source", "Broad scholarship brochure is not specific enough for this award");
  }

  if (isGenericNonAwardDiscoveryUrl(parsed, host, path, directHaystack)) {
    return review("non_award_source", "Generic site page is not specific enough for award monitoring");
  }

  if (isKnownBadAwardSourceAssociation(parsed, host, path, directHaystack, awardName)) {
    return review(
      "cross_program_source",
      "Source appears to describe a different award, calendar, archive, or broad listing",
    );
  }

  if (isKnownBoilerplateUrl(host, path, directHaystack)) {
    return review("boilerplate_or_policy_link", "Boilerplate, policy, news, event, or generic resource link");
  }

  if (isCrossProgramOrBroadListingSource(directHaystack, awardName)) {
    return review(
      "cross_program_source",
      "Source appears to describe a different award or broad program listing",
    );
  }

  if (isOversizedFailure(message, failureType)) {
    return review("oversized_file", "File is too large for daily monitoring");
  }

  if (isPrivateDocumentUrl(host, path, haystack) && isPrivateFailure(statusCode, failureType, message)) {
    return review("private_document", "Private or gated document cannot be monitored automatically");
  }

  if (isPermanentHttpFailure(statusCode, failureType, message)) {
    return review("permanent_http_failure", "Source returns a permanent HTTP failure");
  }

  if (isSoft404Failure(failureType, message)) {
    return review("soft_404", "Source appears to be a page-not-found or wrong destination");
  }

  if (isBlockedThirdPartyUrl(host, haystack) && isBlockedFailure(statusCode, failureType, message)) {
    return review("blocked_third_party", "Third-party source blocks automated monitoring");
  }

  if (isBlockedFailure(statusCode, failureType, message)) {
    return review("blocked_by_source", "Source blocks automated monitoring");
  }

  return { action: "keep", reason: null, note: null };
}

export function shouldRejectDiscoveredSource(sourceLike = {}) {
  const hygiene = classifySourceHygiene(sourceLike, {});
  return hygiene.action === "review_later" ? hygiene : { action: "keep", reason: null, note: null };
}

export function shouldAutoReviewLaterFailure(sourceLike = {}, failure = {}) {
  const hygiene = classifySourceHygiene(sourceLike, failure);
  return hygiene.action === "review_later" ? hygiene : { action: "keep", reason: null, note: null };
}

function review(reason, note) {
  return { action: "review_later", reason, note };
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isSocialOrShareUrl(host, path, haystack) {
  return (
    /(^|\.)facebook\.com$/.test(host) ||
    /(^|\.)twitter\.com$/.test(host) ||
    /(^|\.)x\.com$/.test(host) ||
    /(^|\.)linkedin\.com$/.test(host) ||
    /(^|\.)reddit\.com$/.test(host) ||
    /(^|\.)pinterest\.com$/.test(host) ||
    /(^|\.)addthis\.com$/.test(host) ||
    /(^|\.)sharethis\.com$/.test(host) ||
    /\b(sharer\.php|share\?|intent\/tweet|addtoany|mailto:|social share|facebook|twitter|linkedin|instagram|youtube)\b/.test(
      haystack,
    ) ||
    /\/share(?:\/|$)/.test(path)
  );
}

function isMediaOrArchiveUrl(path) {
  return /\.(?:mp4|mov|avi|webm|mp3|wav|zip|rar|7z|tar|gz|jpg|jpeg|png|gif|webp|svg|ics)(?:$|[?#])/i.test(
    path,
  );
}

function isRecursiveOrCyclicUrl(path) {
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const counts = new Map();
  for (const segment of segments) {
    if (segment.length < 4) continue;
    const count = (counts.get(segment) || 0) + 1;
    counts.set(segment, count);
    if (count >= 3) return true;
  }
  return false;
}

function isGenericNonAwardDiscoveryUrl(parsed, host, path, directHaystack) {
  const cleanPath = path.toLowerCase();
  const cleanSearch = String(parsed?.search || "").toLowerCase();
  const hasAwardSignal =
    /\b(apply|application|applicant|eligib|deadline|due date|requirements?|materials?|guidelines?|nomination|portal|faq|fellowships?|scholarships?|grants?|awards?)\b/.test(
      directHaystack,
    );

  if (
    /\/(?:recipes?|cooking-school|nutrition|foodservice|manufacturers?|professionals?|professional-resources|certification|get-certified|recertification|technical-resources|on-demand|courses?|course-catalog|training|learning|ceu|webinars?|podcasts?|sunnyside-up)(?:\/|$)/.test(
      cleanPath,
    )
  ) {
    return true;
  }

  if (
    (/(?:^|\.)iie\.org$/.test(host) && /^(?:\/|\/connect\/?|\/connect\/students\/?)$/.test(cleanPath)) ||
    /\/connect\/students\/participant-tax-service-information(?:\/|$)/.test(cleanPath)
  ) {
    return true;
  }

  if (
    /(?:^|\.)mainsheet\.mysticseaport\.org$/.test(host) ||
    (/(?:^|\.)hbswk\.hbs\.edu$/.test(host) && /\/item\//.test(cleanPath)) ||
    (/^catalog\./.test(host) && /\/discovery\/collectiondiscovery/.test(cleanPath)) ||
    (/(?:^|\.)studentaid\.alberta\.ca$/.test(host) && /\/policy\/student-aid-policy-manual\//.test(cleanPath)) ||
    (/(?:^|\.)home\.treasury\.gov$/.test(host) && /\/system\/files\/131\//.test(cleanPath) && !/\b(junior fellowship|international affairs|application|apply|eligib|deadline|fellowship)\b/.test(directHaystack)) ||
    (/(?:^|\.)home\.treasury\.gov$/.test(host) && /\/services\/the-multiemployer-pension-reform-act-of-2014\//.test(cleanPath)) ||
    (/(?:^|\.)lung\.org$/.test(host) && /^(?:\/|\/research\/?)$/.test(cleanPath) && !/\b(grant|award|application|eligib|deadline|fellowship)\b/.test(directHaystack)) ||
    (/(?:^|\.)jpf\.go\.jp$/.test(host) && /\/e\/(?:about\/citizen|project\/japanese\/teach\/support)\//.test(cleanPath)) ||
    (/(?:^|\.)acf\.gov$/.test(host) && /\/(?:css\/outreach-material|css\/employers\/child-support-portal)(?:\/|$)/.test(cleanPath)) ||
    (/(?:^|\.)getty\.edu$/.test(host) && /\/(?:calendar|projects|publications)\//.test(cleanPath) && !hasAwardSignal)
  ) {
    return true;
  }

  if (
    /\/(?:people|person|faculty|staff|board|alumni|testimonials?|success-stories|recipient|recipients?|fellows-directory|meet-our-[^/]*fellows|meet-[^/]*scholars|scholars-housing|center-associate|housing|mission-areas|science\/mission-areas|activities-and-networking|lectures|summer-alumni|equal-opportunities|innovation-techtransfer|nccr-spinoff|startups?)(?:\/|$)/.test(
      cleanPath,
    )
  ) {
    return true;
  }

  if (/\/(?:room|reese-house-room)-?\d{2,4}(?:\/|$)/.test(cleanPath)) {
    return true;
  }

  if (
    /\/(?:grantee|grantees|awardee|awardees|recipient|recipients?|fellows-directory|faculty\/research\/publications|faculty\/pages\/item\.aspx|university-ad)(?:\/|$)/.test(
      cleanPath,
    )
  ) {
    return true;
  }

  if (
    /\/(?:privacy-policy|cookie-policy|ferpa|subject-index|subject-indexing|calendar-conferences|announcements?)(?:\/|$)/.test(
      cleanPath,
    )
  ) {
    return true;
  }

  if (/\/news(?:\/|$)/.test(cleanPath) && !hasAwardSignal) {
    return true;
  }

  if (/\/(?:contact|contact-us|about\/contact)(?:\/|\.html?|$)/.test(cleanPath) && !hasAwardSignal) {
    return true;
  }

  if (/\bcalendar\b|ev_calendar_day/.test(cleanPath) && !hasAwardSignal) {
    return true;
  }

  if (/\boption=com_jevents\b/.test(cleanSearch) || /\btask=month\.calendar\b/.test(cleanSearch)) {
    return true;
  }

  if (
    /\b(ferpa for students|subject index terms|submit your news|calendar of conferences|cookie policy|privacy policy|fellowship privacy statement|selection committees?|staff directory|committee members?)\b/.test(
      directHaystack,
    )
  ) {
    return true;
  }

  if (/^\s*(read more|more|learn more|lire plus|email)\s*$/i.test(directHaystack.replace(/^https?:\/\/\S+\s+/i, "")) && !hasAwardSignal) {
    return true;
  }

  if (
    /\b(content marketing|mobile marketing|marketing automation|influencer marketing|overview of marketing|egg nutrition|nutrition facts|egg safety|food safety|foodservice|manufacturers overview|recertification|certification faqs?|professional resources|participant tax service|filing your tax return|tax liability for foreign recipients|sprintax|nonresident alien income tax|form 8843|form 1042-s|room \d{2,4}|meet our fellows|recent fellows|fellows directory|grant recipients?|award recipients?|alumni|testimonials|success stories|authorization letter|withdrawal letter|initial approval letter|final approval letter|notification letter|pension fund|local \d{2,4})\b/.test(
      directHaystack,
    )
  ) {
    return true;
  }

  if (
    /\b(transcripts?|panel discussion|nonprofit leader panel|educational stakeholders panel|digital collections?|exhibition sources?|collection discovery|special collections?|history of science|inside one startup|hiring barriers|policy manual|educator wellness day|concrete art|conservation workshop|submit to the getty research journal|prizes for global citizenship|japanese-language education|child support portal|countries accepting payments)\b/.test(
      directHaystack,
    )
  ) {
    return true;
  }

  if (/(?:^|\.)incredibleegg\.org$/.test(host) && !/\b(award|grant|fellow|scholar|young investigator|application)\b/.test(directHaystack)) {
    return true;
  }

  return false;
}

function isKnownBadAwardSourceAssociation(parsed, host, path, directHaystack, awardName) {
  const cleanPath = path.toLowerCase();
  const cleanSearch = String(parsed?.search || "").toLowerCase();
  const awardSignal = wordSignal(awardName);
  const sourceSignal = wordSignal(`${directHaystack} ${cleanPath} ${cleanSearch}`);

  if (host === "fields.utoronto.ca" && cleanPath === "/activities/thematic") return true;
  if (host === "postdocs.ubc.ca" && cleanPath === "/awards-funding") return true;
  if (host === "ncbi.nlm.nih.gov" && /^\/books(?:\/|$)/.test(cleanPath)) return true;
  if (host === "ncbi.nlm.nih.gov" && /^\/medline\/publisherportal(?:\/|$)/.test(cleanPath)) return true;
  if (host === "www8.nationalacademies.org" && /\/pa\/managerequest\.aspx$/.test(cleanPath)) return true;
  if (host === "fastlane.nsf.gov" && cleanPath === "/fastlane.jsp") return true;
  if (host === "nsf.gov" && cleanPath === "/funding/programs.jsp" && /\borg=sbe\b/.test(cleanSearch)) {
    return true;
  }
  if ((host === "nsf.gov" || host === "beta.nsf.gov") && /^\/geo\/(?:ags|ear)(?:\/|$)/.test(cleanPath)) {
    return true;
  }
  if (host === "croucher.org.hk" && /croucher-science-communication-studentships/.test(cleanPath)) {
    return !/\bscience communication\b/.test(awardSignal);
  }
  if (host === "usascholarships.com" && /\/barbizon-college-tuition-scholarship-program(?:\/|$)/.test(cleanPath)) {
    return true;
  }
  if (host === "gerda-henkel-stiftung.de" && cleanPath === "/en/prize") return true;
  if (host === "aotf.org" && cleanPath === "/funding/") return true;
  if (host === "apf.apa.org" && cleanPath === "/" && !/\bapf\b.*\b(?:fellowship|scholarship|grant)\b/.test(sourceSignal)) {
    return true;
  }
  if (host === "gsa.gov" && /^\/reference\/(?:civil-rights-programs|freedom-of-information-act-foia)(?:\/|$)/.test(cleanPath)) {
    return true;
  }
  if (host === "lung.org" && /^\/get-involved\/ways-to-give(?:\/|$)/.test(cleanPath)) return true;
  if (host === "seg.org" && /\/programs\/student-programs\/seg-evolve(?:\/|$)/.test(cleanPath)) {
    return /\bscholarships?\b/.test(awardSignal);
  }
  if (/(^|\.)shafr\.org$/.test(host) && (/\boption=com_jevents\b/.test(cleanSearch) || /\btask=month\.calendar\b/.test(cleanSearch))) {
    return true;
  }
  if (host === "dowjonesnewsfund.org" && /\/news\/students-can-apply-for-2019-internships(?:\/|$)/.test(cleanPath)) {
    return true;
  }
  if (host === "pgfusa.org" && /\/2022-awards-program(?:\/|$)/.test(cleanPath)) return true;
  if (
    host === "costumesocietyamerica.com" &&
    /\bstella\b.*\bblum\b/.test(awardSignal) &&
    !/stella|travel-research-grant/.test(cleanPath)
  ) {
    return true;
  }

  return false;
}

function isDuplicatePdfExportUrl(host, path) {
  return (
    /(^|\.)daad\.de$/.test(host) &&
    /\/deutschland\/stipendium\/datenbank\/[^/]+\/21148-scholarship-database\.pdf$/i.test(path)
  );
}

function isBroadAcademicPdfSpillover(host, path, signal, awardName) {
  if (!/\.pdf(?:$|[?#])/i.test(path)) return false;
  if (host === "static.daad.de" && hasAwardTokenMatch(signal, awardName, 1)) return false;
  if (hasAwardTokenMatch(signal, awardName)) return false;

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

function hasAwardTokenMatch(signal, awardName, minimum = 2) {
  const sourceSignal = wordSignal(signal);
  const tokens = distinctiveAwardTokens(awardName);
  if (tokens.length === 0) return false;
  const matches = tokens.filter((token) => tokenAppears(sourceSignal, token));
  return matches.length >= Math.min(minimum, tokens.length);
}

function isGenericListingOrSearchShape(url, directHaystack) {
  const path = String(url?.pathname || "").toLowerCase();

  return (
    /\/(?:tag|tags|category|categories)(?:\/|$)/.test(path) ||
    /\/(?:search|search-results?|site-search|search-results-page)(?:\/|\.html?|\.aspx?|$)/.test(path) ||
    /\/(?:guidelinesearch|sitesearch|search|searchresults?)\.(?:html?|aspx?|php)$/.test(path) ||
    hasGenericSearchQuery(url, directHaystack)
  );
}

function hasGenericSearchQuery(url, directHaystack) {
  if (isSpecificAwardDetailSignal(directHaystack)) return false;

  const path = String(url?.pathname || "").toLowerCase().replace(/\/+$/g, "") || "/";
  const titleSearchSignal = /\b(search results?|site search|back to search|results for)\b/i.test(
    directHaystack,
  );

  for (const [rawKey, rawValue] of url?.searchParams?.entries?.() || []) {
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

function isSpecificAwardDetailSignal(value) {
  return /\b(how to apply|application process|application requirements?|eligibility requirements?|program requirements?|deadline|due date|faq|frequently asked questions?)\b/i.test(
    value,
  );
}

function isKnownBoilerplateUrl(host, path, haystack) {
  const hasAwardSignal =
    /\b(apply|application|applicant|eligib|deadline|due date|requirements?|materials?|guidelines?|nomination|portal|faq|fellowships?|scholarships?|grants?|awards?)\b/.test(
      haystack,
    );
  const hasApplicationSignal =
    /\b(apply|application|applicant|eligib|deadline|due date|nomination|portal|faq|how to apply|application process|application tips)\b/.test(
      haystack,
    );
  if (
    /\b(privacy|terms|accessibility|copyright|cookie|subscribe|newsletter|donate|cart|checkout|login|sign in|log in)\b/.test(
      haystack,
    )
  ) {
    return true;
  }
  if (
    /\b(annual report|bylaws?|board of directors|staff directory|media kit|press kit|sponsorship|advertising|code of conduct|anti-discrimination|anti-harassment|emergency contacts?)\b/.test(
      haystack,
    )
  ) {
    return true;
  }
  if (
    /\b(news|press release|blog|events?|calendar|webinar|podcast|story|stories|recipient profile|past recipients?)\b/.test(
      haystack,
    ) &&
    !hasAwardSignal
  ) {
    return true;
  }
  if (/\/(?:news|blog|events?|calendar|press)(?:\/|$)/.test(path) && !hasApplicationSignal) {
    return true;
  }
  if (/\/(?:privacy|terms|accessibility)(?:\/|$)/.test(path)) {
    return true;
  }
  return /(?:^|\.)youtube\.com$/.test(host) || /(?:^|\.)youtu\.be$/.test(host) || /(?:^|\.)vimeo\.com$/.test(host);
}

function isCrossProgramOrBroadListingSource(directHaystack, awardName) {
  const awardTokens = distinctiveAwardTokens(awardName);
  if (awardTokens.length < 2) return false;

  const normalizedSignal = wordSignal(directHaystack);
  const matchingTokens = awardTokens.filter((token) => tokenAppears(normalizedSignal, token));
  const hasEnoughAwardMatch = matchingTokens.length >= Math.min(2, awardTokens.length);
  if (hasEnoughAwardMatch) return false;

  return (
    /\b(request for applications?|funding opportunities?|policies and procedures|award instructions?|sam faqs?|simons award manager|brand portal|job board|available grants?)\b/.test(
      normalizedSignal,
    ) ||
    /\b(fellows? to faculty|shenoy undergraduate research fellowship|surfin|quantum materials?|graduate scholars program|plasticity and the aging brain|scpab|sfari|neuroscience)\b/.test(
      normalizedSignal,
    ) ||
    /\b(iie heiskell awards?|heiskell awards?|eligibility nomination)\b/.test(
      normalizedSignal,
    )
  );
}

function distinctiveAwardTokens(value) {
  const stop = new Set([
    "award",
    "awards",
    "academic",
    "akademischer",
    "austauschdienst",
    "daad",
    "deutscher",
    "exchange",
    "fellow",
    "fellowship",
    "fellowships",
    "foundation",
    "foundations",
    "grant",
    "grants",
    "graduate",
    "german",
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
    "student",
    "students",
    "service",
    "undergraduate",
  ]);

  const tokens = String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 4 && !stop.has(token));

  return [...new Set(tokens)].slice(0, 12);
}

function wordSignal(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenAppears(signal, token) {
  return new RegExp(`\\b${token}\\b`, "i").test(signal);
}

function isOversizedFailure(message, failureType) {
  return /too large|limit \d+ bytes|oversized/i.test(message) || failureType === "too_large";
}

function isPrivateDocumentUrl(host, path, haystack) {
  return (
    /(?:^|\.)docs\.google\.com$/.test(host) ||
    /(?:^|\.)drive\.google\.com$/.test(host) ||
    /\bgoogle docs?|drive\.google|private document|gated document\b/.test(haystack) ||
    /\/document\/d\//.test(path)
  );
}

function isPrivateFailure(statusCode, failureType, message) {
  return statusCode === 401 || failureType === "http_401" || /\bhttp 401\b|unauthorized|permission/i.test(message);
}

function isPermanentHttpFailure(statusCode, failureType, message) {
  if ([400, 401, 404, 405, 410, 409].includes(statusCode || 0)) return true;
  return /\bhttp_(?:400|401|404|405|409|410)\b/.test(failureType) || /\bHTTP (?:400|401|404|405|409|410)\b/i.test(message);
}

function isSoft404Failure(failureType, message) {
  return failureType === "soft_404" || /soft_404|page not found|404 not found/i.test(message);
}

function isBlockedThirdPartyUrl(host, haystack) {
  return (
    /(?:^|\.)studocu\.com$/.test(host) ||
    /(?:^|\.)oxfordbibliographies\.com$/.test(host) ||
    /(?:^|\.)socialstudies\.org$/.test(host) ||
    /(?:^|\.)osti\.gov$/.test(host) ||
    /(?:^|\.)s3\.amazonaws\.com$/.test(host) ||
    /\bthird-party|external reading|reading list|recommended reading\b/.test(haystack)
  );
}

function isBlockedFailure(statusCode, failureType, message) {
  return (
    statusCode === 403 ||
    failureType === "http_403" ||
    failureType === "security_challenge" ||
    failureType === "access_blocked" ||
    /\bHTTP 403\b|forbidden|access denied|security_challenge|robot challenge/i.test(message)
  );
}
