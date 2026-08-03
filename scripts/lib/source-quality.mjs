import {
  explainSourceAiReviewStatus,
  sourceBaselineFacts,
} from "./source-ai-review-status.mjs";

export { sourceBaselineFacts } from "./source-ai-review-status.mjs";

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
const broadProgramSearchPath =
  /\/(?:find-programs?|program-search|search-programs?|programs\/search|scholarship-search|scholarships\/search|database\/search)(?:[?#/]|$)/i;
const trackingQuery = /[?&](share|replytocom|utm_|fbclid|gclid|redirect_to=)/i;
const nonMonitorableAsset = /\.(jpg|jpeg|png|gif|webp|svg|zip|ics|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/i;
const badUploadHtmlTerms = /(viagra|levitra|cialis|pharma|casino|xanax|tramadol|pills|essay-writing|payday)/i;
const phoneNumberPathSegment = /(?:^|\/)\+?(?:\d[\d().-]*){9,}(?:\/|$)/;

const rejectedQualityFlags = new Set([
  "source-mismatch",
  "spam",
  "job-board",
  "career-page",
  "search-results",
  "generic-listing",
  "sibling-program",
  "access-error",
  "hacked-page",
  "pharma-spam",
  "unrelated-program",
]);
const spamUploadTitle =
  /\b(viagra|levitra|cialis|pharma|casino|xanax|tramadol|pills|essay writing|payday)\b/i;
const STAGE1_BASELINE_EVIDENCE_PACKET_SHA256 =
  "8a1c1d9aa8ccbdf1dcdbb7b2f4b83ac19c99dd9557a8949dff5f63dd22d1026f";
const STAGE1_BASELINE_APPROVED_REQUEST_IDS = new Set([
  "62a291a2-e64d-5788-a876-f2dca551a021",
  "cc190ad2-8240-5b8c-b5ac-a73180094d24",
  "2bd3018c-d1b6-5d39-85ed-ea278e9d3702",
  "e01d9d33-47de-5ba9-b83c-d6e7c69a4c7f",
  "27ad713b-0332-59e6-b28b-44b9ff631bc1",
  "fd02cb92-8ab6-553f-8e31-752802ac4641",
  "a97507bf-295a-5a81-99e5-4516f96c9612",
  "2cd2f427-753f-5de7-ab0b-616502b287b7",
  "cf731f52-f02d-581e-bf52-c698f53d87d8",
  "4952d327-4fa5-53a0-8247-dd029f7f2c2c",
]);
const STAGE1_SOURCE_ROLES = new Set([
  "identity_home",
  "eligibility",
  "application_materials",
  "dates_cycle",
  "funding",
  "faq",
  "selection_interviews",
  "current_documents",
]);

export function sourceQualityDecision(source, { purpose }) {
  const facts = sourceBaselineFacts(source);
  const metadata = objectValue(source?.page_metadata);
  const hasBaselineFacts = Object.keys(facts).length > 0;
  const metadataExists = sourceMetadataExists(source, metadata);
  const qualityFlags = normalizedQualityFlags(metadata, facts);
  const reject = (reason) => ({
    allowed: false,
    reason,
    facts,
    hasBaselineFacts,
    metadataExists,
    qualityFlags,
  });
  const allow = (reason = "allowed") => ({
    allowed: true,
    reason,
    facts,
    hasBaselineFacts,
    metadataExists,
    qualityFlags,
  });

  if (!source?.url) return reject("missing_url");

  if (purpose === "monitoring" || purpose === "discovery") {
    if (!isMonitorableOfficialSource(source)) return reject("url_not_monitorable");
  } else if (!isTrackableOfficialSourceUrl(source.url)) {
    return reject("url_not_public_trackable");
  }

  const titleSignal = [source.title, source.display_title, metadata.page_title, facts.display_title]
    .map((value) => String(value || ""))
    .join(" ");
  if (isSpamUploadHtmlSource(source.url, titleSignal)) return reject("url_spam_upload_html");

  const stage1Approval = stage1BaselineMonitoringApprovalStatus(source, metadata);
  if (stage1Approval === "invalid") {
    return reject("stage1_baseline_monitoring_approval_invalid");
  }
  if (stage1Approval === "valid") {
    if (purpose === "monitoring") return allow("stage1_baseline_monitoring_only");
    if (purpose === "public" || purpose === "facts") {
      return reject("stage1_baseline_monitoring_only_no_fact_authority");
    }
    if (purpose === "discovery") {
      return reject("stage1_baseline_monitoring_only_no_discovery_authority");
    }
  }

  if (purpose === "public" || purpose === "facts" || purpose === "monitoring") {
    const review = explainSourceAiReviewStatus(source);
    if (purpose === "monitoring" && !review.canBeMonitored) {
      return reject(`ai_review_${review.status}_${review.reason}`);
    }
    if ((purpose === "public" || purpose === "facts") && !review.canContributePublicFacts) {
      return reject(`ai_review_${review.status}_${review.reason}`);
    }
    return allow(`ai_review_${review.status}`);
  }

  if (
    metadata.baseline_facts_rejected === true ||
    metadata.baselineFactsRejected === true ||
    objectValue(metadata.baseline_facts_metadata).rejected === true
  ) {
    return reject("baseline_facts_rejected");
  }

  const badFlag = qualityFlags.find((flag) => rejectedQualityFlags.has(flag));
  if (badFlag) return reject(`quality_flag_${badFlag}`);

  const awardRelevance = hasBaselineFacts ? cleanKey(facts.award_relevance) || "unclear" : "";
  if (awardRelevance === "unrelated") return reject("award_relevance_unrelated");
  if (awardRelevance === "unclear" && purpose !== "admin" && purpose !== "debug") {
    return reject("award_relevance_unclear");
  }

  const cycleRelevance = hasBaselineFacts ? cleanKey(facts.cycle_relevance) || "unclear" : "";
  if (cycleRelevance === "not-program-page") return reject("cycle_relevance_not_program_page");
  if (cycleRelevance === "archived-or-past") return reject("cycle_relevance_archived_or_past");
  if (cycleRelevance === "unclear" && purpose !== "admin" && purpose !== "debug") {
    return reject("cycle_relevance_unclear");
  }

  return allow();
}

function stage1BaselineMonitoringApprovalStatus(source, metadata) {
  if (!("stage1_baseline_monitoring_approval" in metadata)) return "absent";
  const approval = objectValue(metadata.stage1_baseline_monitoring_approval);
  const exactKeys = [
    "decision",
    "decision_item_sha256",
    "evidence_packet_sha256",
    "exact_evidence_verified",
    "fact_candidate_authority",
    "notification_mode",
    "policy_version",
    "public_fact_authority",
    "reviewed_roles",
    "schema_version",
    "shared_award_source_id",
    "source_page_request_id",
  ];
  const actualKeys = Object.keys(approval).sort();
  const reviewedRoles = Array.isArray(approval.reviewed_roles)
    ? approval.reviewed_roles
    : [];
  return (
    actualKeys.length === exactKeys.length &&
    actualKeys.every((key, index) => key === exactKeys[index]) &&
    approval.schema_version === "awardping.stage1.baseline-monitoring-approval.v1" &&
    approval.policy_version === "stage1-baseline-source-disposition-v1" &&
    approval.decision === "monitoring_only" &&
    approval.shared_award_source_id === source?.id &&
    STAGE1_BASELINE_APPROVED_REQUEST_IDS.has(approval.source_page_request_id) &&
    approval.evidence_packet_sha256 === STAGE1_BASELINE_EVIDENCE_PACKET_SHA256 &&
    /^[0-9a-f]{64}$/.test(String(approval.decision_item_sha256 || "")) &&
    approval.exact_evidence_verified === true &&
    approval.notification_mode === "baseline_only" &&
    approval.public_fact_authority === false &&
    approval.fact_candidate_authority === false &&
    reviewedRoles.length > 0 &&
    new Set(reviewedRoles).size === reviewedRoles.length &&
    reviewedRoles.every((role) => STAGE1_SOURCE_ROLES.has(role)) &&
    [...reviewedRoles].sort().every((role, index) => role === reviewedRoles[index])
  ) ? "valid" : "invalid";
}

export function isPublicAwardSource(source) {
  return sourceQualityDecision(source, { purpose: "public" }).allowed;
}

export function isUsableAwardFactSource(source) {
  return sourceQualityDecision(source, { purpose: "facts" }).allowed;
}

export function isMonitorableAwardSource(source) {
  return sourceQualityDecision(source, { purpose: "monitoring" }).allowed;
}

export function isTrackableOfficialSourceUrl(value) {
  return Boolean(value) && !isInstitutionalDiscoveryUrl(value) && !isClearlyNonAwardSourceUrl(value);
}

export function isMonitorableOfficialSource(source) {
  if (!source?.url || isInstitutionalDiscoveryUrl(source.url)) return false;
  if (isHardBlockedOfficialSourceUrl(source.url)) return false;
  if (isClearlyNonAwardSourceUrl(source.url)) return false;
  return true;
}

function isInstitutionalDiscoveryUrl(value) {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return institutionalDiscoveryHosts.has(hostname);
  } catch {
    return false;
  }
}

function isClearlyNonAwardSourceUrl(value) {
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

function isHardBlockedOfficialSourceUrl(value) {
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

function sourceMetadataExists(source, metadata) {
  return Boolean(
    source?.page_metadata_generated_at ||
      Object.keys(metadata).length ||
      metadata.baseline_facts ||
      metadata.baselineFacts ||
      metadata.baseline_facts_rejected,
  );
}

function normalizedQualityFlags(metadata, facts) {
  return [
    ...stringArray(facts.quality_flags),
    ...stringArray(metadata.quality_flags),
    ...stringArray(objectValue(metadata.baseline_facts_metadata).quality_flags),
    cleanKey(metadata.rejection_reason),
  ]
    .map(cleanKey)
    .filter(Boolean);
}

function isSpamUploadHtmlSource(urlValue, titleSignal) {
  try {
    const url = new URL(urlValue);
    return (
      /\/wp-content\/uploads\/\d{4}\/\d{2}\/[^/]+\.html?$/i.test(url.pathname) &&
      spamUploadTitle.test(`${titleSignal} ${decodeURIComponent(url.pathname)}`)
    );
  } catch {
    return false;
  }
}

function isKnownSpamOrAccessUrl(hostname, url) {
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

function isBroadScholarshipDatabaseListingUrl(hostname, url) {
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

function isDuplicateOrBroadPdfUrl(hostname, pathname) {
  return (
    /(^|\.)daad\.de$/.test(hostname) &&
    /\/deutschland\/stipendium\/datenbank\/[^/]+\/21148-scholarship-database\.pdf$/i.test(pathname)
  ) || (
    hostname === "studieren-weltweit.de" &&
    /\/content\/uploads\/\d{4}\/\d{2}\/mit-stipendium-ins-ausland\.pdf$/i.test(pathname)
  );
}

function isNationalAcademiesNonAwardUrl(hostname, url) {
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

function isOpenDataListingOrFacetUrl(hostname, url) {
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

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || ""));
  if (typeof value === "string") return value.split(/[,;|]/);
  return [];
}

function cleanKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-");
}
