import {
  isMonitorableOfficialSource,
  isTrackableOfficialSourceUrl,
} from "@/lib/source-url-policy";

export type SourceQualityPurpose =
  | "public"
  | "facts"
  | "monitoring"
  | "discovery"
  | "admin"
  | "debug";

export type SourceQualitySource = {
  url?: string | null;
  title?: string | null;
  display_title?: string | null;
  page_description?: string | null;
  page_metadata?: unknown;
  page_metadata_generated_at?: string | null;
  page_type?: string | null;
  source?: string | null;
  reason?: string | null;
  submitted_by_user_id?: string | null;
};

export type SourceQualityDecision = {
  allowed: boolean;
  reason: string;
  facts: Record<string, unknown>;
  hasBaselineFacts: boolean;
  metadataExists: boolean;
  qualityFlags: string[];
};

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
const protectedMissingFactsPageTypes = new Set([
  "homepage",
  "application",
  "deadline",
  "requirements",
  "eligibility",
  "pdf",
]);
const manualSourceSignals = new Set([
  "admin",
  "manual",
  "curated",
  "seed",
  "user",
  "source-override",
  "source_override",
  "source-overrides",
  "official",
]);
const spamUploadTitle =
  /\b(viagra|levitra|cialis|pharma|casino|xanax|tramadol|pills|essay writing|payday)\b/i;

export function sourceBaselineFacts(source: SourceQualitySource | null | undefined) {
  const metadata = objectValue(source?.page_metadata);
  const facts = objectValue(metadata.baseline_facts || metadata.baselineFacts);
  if (Object.keys(facts).length) return facts;
  if (metadata.kind || metadata.provider || metadata.model || metadata.baseline_facts_rejected) {
    return {};
  }
  return metadata;
}

export function sourceQualityDecision(
  source: SourceQualitySource | null | undefined,
  options: { purpose: SourceQualityPurpose },
): SourceQualityDecision {
  const purpose = options.purpose;
  const facts = sourceBaselineFacts(source);
  const metadata = objectValue(source?.page_metadata);
  const hasBaselineFacts = Object.keys(facts).length > 0;
  const metadataExists = sourceMetadataExists(source, metadata);
  const qualityFlags = normalizedQualityFlags(metadata, facts);
  const reject = (reason: string): SourceQualityDecision => ({
    allowed: false,
    reason,
    facts,
    hasBaselineFacts,
    metadataExists,
    qualityFlags,
  });
  const allow = (reason = "allowed"): SourceQualityDecision => ({
    allowed: true,
    reason,
    facts,
    hasBaselineFacts,
    metadataExists,
    qualityFlags,
  });

  if (!source?.url) return reject("missing_url");

  if (purpose === "monitoring" || purpose === "discovery") {
    if (!isMonitorableOfficialSource({ url: source.url, page_type: source.page_type })) {
      return reject("url_not_monitorable");
    }
  } else if (!isTrackableOfficialSourceUrl(source.url)) {
    return reject("url_not_public_trackable");
  }

  const titleSignal = [source.title, source.display_title, metadata.page_title, facts.display_title]
    .map((value) => String(value || ""))
    .join(" ");
  if (isSpamUploadHtmlSource(source.url, titleSignal)) return reject("url_spam_upload_html");

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

  if (!hasBaselineFacts) {
    if (purpose === "facts" || purpose === "public") return reject("missing_baseline_facts");
    if (purpose === "monitoring" && !missingBaselineFactsCanBeMonitored(source)) {
      return reject("missing_baseline_facts_not_monitorable");
    }
  }

  return allow();
}

export function isPublicAwardSource(source: SourceQualitySource | null | undefined) {
  return sourceQualityDecision(source, { purpose: "public" }).allowed;
}

export function isUsableAwardFactSource(source: SourceQualitySource | null | undefined) {
  return sourceQualityDecision(source, { purpose: "facts" }).allowed;
}

export function isMonitorableAwardSource(source: SourceQualitySource | null | undefined) {
  return sourceQualityDecision(source, { purpose: "monitoring" }).allowed;
}

function sourceMetadataExists(source: SourceQualitySource | null | undefined, metadata: Record<string, unknown>) {
  return Boolean(
    source?.page_metadata_generated_at ||
      Object.keys(metadata).length ||
      metadata.baseline_facts ||
      metadata.baselineFacts ||
      metadata.baseline_facts_rejected,
  );
}

function missingBaselineFactsCanBeMonitored(source: SourceQualitySource) {
  const pageType = cleanKey(source.page_type);
  if (protectedMissingFactsPageTypes.has(pageType)) return true;
  const sourceSignal = cleanKey(source.source || source.reason);
  return manualSourceSignals.has(sourceSignal) || Boolean(source.submitted_by_user_id);
}

function normalizedQualityFlags(metadata: Record<string, unknown>, facts: Record<string, unknown>) {
  return [
    ...stringArray(facts.quality_flags),
    ...stringArray(metadata.quality_flags),
    ...stringArray(objectValue(metadata.baseline_facts_metadata).quality_flags),
    cleanKey(metadata.rejection_reason),
  ]
    .map(cleanKey)
    .filter(Boolean);
}

function isSpamUploadHtmlSource(urlValue: string, titleSignal: string) {
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item || ""));
  if (typeof value === "string") return value.split(/[,;|]/);
  return [];
}

function cleanKey(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-");
}
