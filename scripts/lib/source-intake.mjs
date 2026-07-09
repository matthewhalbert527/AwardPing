import * as cheerio from "cheerio";
import { normalizeAwardName, awardIdentityScore } from "./award-fact-reconciliation.mjs";
import { sourceQualityDecision } from "./source-quality.mjs";

export const intakeStatuses = new Set([
  "pending",
  "queued",
  "validating",
  "capturing",
  "ai_review_pending",
  "ai_review_submitted",
  "ai_review_succeeded",
  "matching",
  "needs_manual_review",
  "added",
  "rejected",
  "failed",
]);

const trackingParams = /^(utm_|fbclid$|gclid$|mc_|_hs|vero_|igshid$|ref$|source$|campaign$)/i;
const unsafeHostPattern = /(?:^|\.)localhost$|(?:^|\.)local$|(?:^|\.)internal$|(?:^|\.)invalid$|(?:^|\.)test$|(?:^|\.)example$/i;
const genericListingPattern = /\b(search|results?|listing|directory|database|finder|find-programs?|program-search|scholarship-search|tag|category|archive)\b/i;
const noisePathPattern = /\/(?:careers?|jobs?|employment|profile|profiles?|recipients?|awardees?|fellows?|news|events?|calendar|payment|payments|billing|bursar|1098t|1098-t|security|question|login|signin|sign-in|account|donate|privacy|terms)(?:[/?#]|$)/i;
const accessTextPattern = /\b(access denied|forbidden|captcha|security question|sign in required|log in required|please login|not authorized)\b/i;
const spamTextPattern = /\b(viagra|levitra|cialis|casino|xanax|tramadol|payday|pharma)\b/i;
const awardSignalPattern = /\b(award|scholarship|fellowship|grant|funding|application|apply|eligibility|deadline|stipend|tuition|nomination)\b/i;
const pdfPattern = /\.pdf(?:$|[?#])/i;
const acceptedRelevance = new Set(["primary", "supporting"]);
const acceptedCycle = new Set(["current_or_upcoming", "evergreen"]);
const awardPageTypes = new Set(["homepage", "application", "deadline", "eligibility", "requirements", "faq", "pdf", "other"]);

export function normalizeSourceIntakeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Enter a URL.");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only public http and https URLs can be reviewed.");
  if (unsafeHostPattern.test(url.hostname) || isPrivateIpLikeHost(url.hostname)) {
    throw new Error("Private, local, or internal URLs cannot be reviewed.");
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (trackingParams.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/g, "");
  return url.toString();
}

export function deterministicSourceIntakeReview(input) {
  let normalizedUrl = null;
  try {
    normalizedUrl = normalizeSourceIntakeUrl(input.url);
  } catch (error) {
    return review(false, "rejected", errorMessage(error), "other", [], null, input);
  }
  const titleSignal = cleanText(input.title);
  const textSignal = cleanText(input.text).slice(0, 8000);
  const combined = `${normalizedUrl} ${titleSignal} ${textSignal}`;
  const pageType = inferIntakePageType({ ...input, url: normalizedUrl, title: titleSignal, text: textSignal });
  const qualityFlags = [];
  if (noisePathPattern.test(normalizedUrl)) qualityFlags.push("blocked-url-shape");
  if (genericListingPattern.test(normalizedUrl) && pageType !== "pdf") qualityFlags.push("generic-listing");
  if (accessTextPattern.test(combined)) qualityFlags.push("access-error");
  if (spamTextPattern.test(combined)) qualityFlags.push("spam");
  if (!awardSignalPattern.test(combined) && pageType !== "pdf") qualityFlags.push("missing-award-signal");

  if (qualityFlags.includes("spam") || qualityFlags.includes("access-error") || qualityFlags.includes("blocked-url-shape")) {
    return review(false, "rejected", qualityFlags[0], pageType, qualityFlags, normalizedUrl, input);
  }
  if (qualityFlags.includes("generic-listing") || qualityFlags.includes("missing-award-signal")) {
    return review(false, "needs_manual_review", qualityFlags[0], pageType, qualityFlags, normalizedUrl, input);
  }
  return review(true, "plausible", "passes_deterministic_intake_gate", pageType, qualityFlags, normalizedUrl, input);
}

export async function captureIntakePage(url, options = {}) {
  const timeoutMs = positiveInt(options.timeoutMs, 30_000);
  const maxBytes = positiveInt(options.maxBytes, 1_500_000);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "AwardPingSourceIntake/1.0 (+https://awardping.com)",
        accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    const contentType = response.headers.get("content-type") || "";
    const finalUrl = normalizeSourceIntakeUrl(response.url || url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const body = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, maxBytes));
    const parsed = parseCapturedContent({ body, contentType, finalUrl });
    return {
      ok: response.ok,
      status_code: response.status,
      final_url: finalUrl,
      canonical_url: parsed.canonical_url || finalUrl,
      content_type: contentType,
      byte_length: bytes.length,
      truncated: bytes.length > maxBytes,
      title: parsed.title,
      page_description: parsed.page_description,
      text: parsed.text,
      links: parsed.links,
      pdf_links: parsed.pdf_links,
      duration_ms: Date.now() - startedAt,
      capture_method: "fetch_html",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseCapturedContent({ body, contentType, finalUrl }) {
  if (/pdf/i.test(contentType) || pdfPattern.test(finalUrl)) {
    return {
      title: titleFromUrl(finalUrl),
      page_description: "",
      canonical_url: finalUrl,
      text: "",
      links: [],
      pdf_links: [],
    };
  }
  const $ = cheerio.load(body || "");
  $("script,style,noscript,template,svg").remove();
  const title = cleanText($("title").first().text() || $("h1").first().text() || titleFromUrl(finalUrl));
  const pageDescription = cleanText($('meta[name="description"]').attr("content") || $("p").first().text()).slice(0, 500);
  const canonicalHref = $('link[rel="canonical"]').attr("href") || "";
  const canonicalUrl = safeAbsoluteUrl(canonicalHref, finalUrl) || finalUrl;
  const text = cleanText($("main").text() || $("article").text() || $("body").text()).slice(0, 60_000);
  const links = [];
  const pdfLinks = [];
  $("a[href]").each((_index, element) => {
    const href = safeAbsoluteUrl($(element).attr("href"), finalUrl);
    if (!href) return;
    const item = {
      url: href,
      title: cleanText($(element).text()).slice(0, 180) || titleFromUrl(href),
    };
    if (pdfPattern.test(href)) pdfLinks.push(item);
    else links.push(item);
  });
  return {
    title,
    page_description: pageDescription,
    canonical_url: canonicalUrl,
    text,
    links: dedupeLinks(links).slice(0, 80),
    pdf_links: dedupeLinks(pdfLinks).slice(0, 40),
  };
}

export function inferIntakePageType(input) {
  const url = String(input.url || "");
  const title = String(input.title || "");
  const text = String(input.text || "").slice(0, 3000);
  const combined = `${url} ${title} ${text}`;
  if (pdfPattern.test(url) || /pdf/i.test(String(input.contentType || ""))) return "pdf";
  if (/\b(faq|frequently asked questions)\b/i.test(combined)) return "faq";
  if (/\b(deadline|due date|closing date|application close)/i.test(combined)) return "deadline";
  if (/\b(eligibility|eligible|who can apply)\b/i.test(combined)) return "eligibility";
  if (/\b(requirements|required|criteria|conditions)\b/i.test(combined)) return "requirements";
  if (/\b(apply|application|portal|submit|nomination)\b/i.test(combined)) return "application";
  if (genericListingPattern.test(combined)) return "listing";
  return "homepage";
}

export function buildGeminiIntakeRequest(request, capture, deterministicReview, model = "gemini-2.5-flash-lite") {
  return {
    request: {
      systemInstruction: {
        parts: [{
          text: [
            "You are AwardPing's strict source-intake reviewer.",
            "Return JSON only. Default to needs_review or rejected when uncertain.",
            "Do not invent deadlines, cycles, award names, or facts.",
            "Classify sibling programs, broad sponsor pages, search/listing pages, access errors, jobs/careers, profiles, recipients, news, and payment pages conservatively.",
            "Accepted facts must cite exact evidence quotes from the supplied page text.",
          ].join(" "),
        }],
      },
      contents: [{
        role: "user",
        parts: [{ text: buildGeminiIntakePrompt(request, capture, deterministicReview) }],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1600,
        responseMimeType: "application/json",
      },
    },
    metadata: { key: request.id, source_page_request_id: request.id, model },
  };
}

export function buildGeminiIntakePrompt(request, capture, deterministicReview) {
  return [
    "Review this pasted source URL for AwardPing intake.",
    "Strict output schema:",
    JSON.stringify({
      status: "accepted|needs_review|rejected",
      detected_award_name: "string|null",
      detected_sponsor: "string|null",
      source_relevance: "primary|supporting|generic_listing|sibling_program|unrelated|unclear|access_error",
      cycle_relevance: "current_or_upcoming|evergreen|archived_or_past|not_program_page|unclear",
      page_type: "homepage|application|deadline|eligibility|requirements|faq|pdf|portal|listing|other",
      officialness: "official|likely_official|third_party|unclear",
      confidence: "high|medium|low",
      evidence_quotes: ["short exact quote"],
      facts: {
        description: "string|null",
        deadline: "string|null",
        amount: "string|null",
        eligibility: [],
        application_materials: [],
        important_dates: [],
      },
      suggested_sources: [{ url: "string", title: "string", page_type: "string", reason: "string", confidence: 0 }],
      rejection_reason: "string|null",
      manual_review_reason: "string|null",
    }),
    "Submitted request:",
    JSON.stringify({
      id: request.id,
      requested_award_name: request.award_name || null,
      notes: request.notes || null,
      submitted_url: request.submitted_url || request.homepage_url,
      normalized_url: request.normalized_url,
      intake_type: request.intake_type || "unknown",
    }),
    "Deterministic review:",
    JSON.stringify(deterministicReview),
    "Captured page:",
    JSON.stringify({
      final_url: capture.final_url,
      canonical_url: capture.canonical_url,
      status_code: capture.status_code,
      content_type: capture.content_type,
      title: capture.title,
      page_description: capture.page_description,
      text_excerpt: cleanText(capture.text).slice(0, 16000),
      pdf_links: (capture.pdf_links || []).slice(0, 10),
      links: (capture.links || []).slice(0, 20),
    }),
  ].join("\n\n");
}

export function normalizeGeminiIntakeResult(value) {
  const result = objectValue(value);
  const sourceRelevance = cleanChoice(result.source_relevance, [
    "primary",
    "supporting",
    "generic_listing",
    "sibling_program",
    "unrelated",
    "unclear",
    "access_error",
  ], "unclear");
  const cycleRelevance = cleanChoice(result.cycle_relevance, [
    "current_or_upcoming",
    "evergreen",
    "archived_or_past",
    "not_program_page",
    "unclear",
  ], "unclear");
  const status = cleanChoice(result.status, ["accepted", "needs_review", "rejected"], "needs_review");
  const pageType = cleanChoice(result.page_type, [
    "homepage",
    "application",
    "deadline",
    "eligibility",
    "requirements",
    "faq",
    "pdf",
    "portal",
    "listing",
    "other",
  ], "other");
  return {
    status,
    detected_award_name: cleanNullable(result.detected_award_name),
    detected_sponsor: cleanNullable(result.detected_sponsor),
    source_relevance: sourceRelevance,
    cycle_relevance: cycleRelevance,
    page_type: pageType,
    officialness: cleanChoice(result.officialness, ["official", "likely_official", "third_party", "unclear"], "unclear"),
    confidence: cleanChoice(result.confidence, ["high", "medium", "low"], "low"),
    evidence_quotes: stringArray(result.evidence_quotes).map((item) => truncate(item, 240)).slice(0, 8),
    facts: normalizeFacts(result.facts),
    suggested_sources: normalizeSuggestedSources(result.suggested_sources),
    rejection_reason: cleanNullable(result.rejection_reason),
    manual_review_reason: cleanNullable(result.manual_review_reason),
    raw: result,
  };
}

export function baselineFactsFromIntakeReview(review) {
  const facts = normalizeGeminiIntakeResult(review);
  const qualityFlags = [];
  if (facts.source_relevance === "generic_listing") qualityFlags.push("generic-listing");
  if (facts.source_relevance === "sibling_program") qualityFlags.push("sibling-program");
  if (facts.source_relevance === "access_error") qualityFlags.push("access-error");
  if (facts.source_relevance === "unrelated") qualityFlags.push("unrelated-program");
  return {
    status: facts.status,
    display_title: facts.detected_award_name || null,
    page_description: facts.facts.description || null,
    award_name_seen: facts.detected_award_name || null,
    award_relevance: facts.source_relevance === "primary" || facts.source_relevance === "supporting"
      ? facts.source_relevance
      : facts.source_relevance === "sibling_program" || facts.source_relevance === "unrelated"
        ? "unrelated"
        : "unclear",
    cycle_relevance: facts.cycle_relevance,
    confidence: facts.confidence,
    evidence_quotes: facts.evidence_quotes,
    quality_flags: qualityFlags,
    rejection_reason: facts.rejection_reason || facts.manual_review_reason || null,
    deadline: facts.facts.deadline,
    award_amount: facts.facts.amount,
    eligibility: facts.facts.eligibility,
    application_materials: facts.facts.application_materials,
    important_dates: facts.facts.important_dates,
    detected_sponsor: facts.detected_sponsor,
  };
}

export function validateIntakeAiDecision(review) {
  const facts = normalizeGeminiIntakeResult(review);
  const evidenceOk = facts.evidence_quotes.length > 0;
  if (facts.status === "rejected") return { accepted: false, manual: false, reason: facts.rejection_reason || facts.source_relevance };
  if (!evidenceOk) return { accepted: false, manual: true, reason: "missing_evidence_quotes" };
  if (!acceptedRelevance.has(facts.source_relevance)) return { accepted: false, manual: facts.source_relevance === "unclear", reason: `source_relevance_${facts.source_relevance}` };
  if (!acceptedCycle.has(facts.cycle_relevance)) return { accepted: false, manual: facts.cycle_relevance === "unclear", reason: `cycle_relevance_${facts.cycle_relevance}` };
  if (!["official", "likely_official"].includes(facts.officialness)) return { accepted: false, manual: true, reason: `officialness_${facts.officialness}` };
  if (facts.confidence === "low") return { accepted: false, manual: true, reason: "confidence_low" };
  return { accepted: true, manual: false, reason: "accepted" };
}

export function matchSourceToExistingAward({ awards, request, capture, review }) {
  const normalizedReview = normalizeGeminiIntakeResult(review);
  const requestedName = request.award_name || "";
  const detectedName = normalizedReview.detected_award_name || requestedName;
  const sourceLike = sourceLikeFromIntake({ request, capture, review });
  let best = null;
  for (const award of awards || []) {
    let score = 0;
    if (detectedName) score += nameSimilarity(award.name, detectedName) * 0.55;
    if (requestedName) score += nameSimilarity(award.name, requestedName) * 0.25;
    if (sameCanonicalUrl(award.official_homepage, capture.canonical_url) || sameCanonicalUrl(award.official_homepage, capture.final_url)) score += 0.35;
    if (sameHost(award.official_homepage, capture.final_url)) score += 0.05;
    score += awardIdentityScore(award, sourceLike, baselineFactsFromIntakeReview(review)) * 0.25;
    if (!best || score > best.score) best = { award, score: clamp(score, 0, 1) };
  }
  return best;
}

export function shouldCreateNewAwardFromIntake({ review, deterministicReview, request, capture, threshold = 0.85 }) {
  const normalized = normalizeGeminiIntakeResult(review);
  if (!deterministicReview.allowed) return { create: false, reason: deterministicReview.reason };
  if (normalized.status !== "accepted") return { create: false, reason: `ai_status_${normalized.status}` };
  if (normalized.source_relevance !== "primary") return { create: false, reason: `source_relevance_${normalized.source_relevance}` };
  if (!["official", "likely_official"].includes(normalized.officialness)) return { create: false, reason: `officialness_${normalized.officialness}` };
  if (normalized.confidence !== "high") return { create: false, reason: "confidence_not_high" };
  const name = normalized.detected_award_name || request.award_name;
  if (!name) return { create: false, reason: "missing_award_name" };
  const evidenceText = `${normalized.evidence_quotes.join(" ")} ${capture.title || ""} ${capture.page_description || ""}`;
  if (nameSimilarity(name, evidenceText) < 0.3 && !evidenceText.toLowerCase().includes(normalizeAwardName(name))) {
    return { create: false, reason: "award_name_not_supported_by_evidence" };
  }
  return { create: threshold <= 1, reason: "accepted_high_confidence_primary" };
}

export function sourceLikeFromIntake({ request, capture, review }) {
  const normalized = normalizeGeminiIntakeResult(review);
  const baselineFacts = baselineFactsFromIntakeReview(normalized);
  return {
    url: capture.canonical_url || capture.final_url || request.normalized_url || request.homepage_url,
    title: capture.title || normalized.detected_award_name || request.award_name || titleFromUrl(capture.final_url || request.homepage_url),
    display_title: normalized.detected_award_name || capture.title || null,
    page_description: normalized.facts.description || capture.page_description || null,
    page_type: normalizeSharedAwardPageType(normalized.page_type),
    confidence: confidenceNumber(normalized.confidence),
    source: "admin",
    reason: normalized.manual_review_reason || normalized.rejection_reason || null,
    page_metadata_generated_at: new Date().toISOString(),
    page_metadata_model: "source-intake-gemini-batch",
    page_metadata: {
      baseline_facts: baselineFacts,
      baseline_facts_metadata: {
        model: "source-intake-gemini-batch",
        intake_request_id: request.id,
        generated_at: new Date().toISOString(),
      },
      intake_review: normalized,
    },
  };
}

export function sourceQualityForIntakeSource(sourceLike) {
  return sourceQualityDecision(sourceLike, { purpose: "monitoring" });
}

export function normalizeSharedAwardPageType(value) {
  if (value === "portal") return "application";
  if (value === "listing") return "other";
  return awardPageTypes.has(value) ? value : "other";
}

export function factCandidateRowsFromIntake({ awardId, sourceId, sourceLike, review }) {
  const normalized = normalizeGeminiIntakeResult(review);
  const evidence = normalized.evidence_quotes[0] || null;
  const rows = [];
  const add = (field, value) => {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    for (const item of values) {
      const raw = cleanText(item);
      if (!raw) continue;
      rows.push({
        shared_award_id: awardId,
        shared_award_source_id: sourceId,
        source_url: sourceLike.url,
        source_title: sourceLike.display_title || sourceLike.title,
        source_role: normalized.source_relevance,
        source_quality_decision: sourceQualityForIntakeSource(sourceLike),
        field_name: field,
        raw_value: raw,
        normalized_value: raw,
        evidence_quote: evidence,
        evidence_location: "source_intake_page_text",
        extracted_at: new Date().toISOString(),
        model: "source-intake-gemini-batch",
        confidence: normalized.confidence,
        candidate_status: "pending",
        metadata: { intake_request_id: normalized.raw?.source_page_request_id || null },
      });
    }
  };
  add("description", normalized.facts.description);
  add("deadline", normalized.facts.deadline);
  add("award_amount", normalized.facts.amount);
  add("eligibility", normalized.facts.eligibility);
  add("application_materials", normalized.facts.application_materials);
  add("important_dates", normalized.facts.important_dates);
  if (sourceLike.page_type === "homepage") add("official_homepage_url", sourceLike.url);
  if (sourceLike.page_type === "application") add("application_url", sourceLike.url);
  if (sourceLike.page_type === "faq") add("faq_url", sourceLike.url);
  return rows;
}

export function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  const text = String(value).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || payload?.response?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || "").join("\n").trim();
}

export function geminiInlineResponsePayload(item) {
  return item?.response || item?.generateContentResponse || item;
}

function review(allowed, status, reason, pageType, qualityFlags, normalizedUrl, input) {
  return {
    allowed,
    status,
    reason,
    pageType,
    qualityFlags,
    normalizedUrl,
    titleSignal: cleanText(input.title),
    textSignal: cleanText(input.text).slice(0, 8000),
  };
}

function normalizeFacts(value) {
  const facts = objectValue(value);
  return {
    description: cleanNullable(facts.description),
    deadline: cleanNullable(facts.deadline),
    amount: cleanNullable(facts.amount || facts.award_amount),
    eligibility: stringArray(facts.eligibility).slice(0, 12),
    application_materials: stringArray(facts.application_materials).slice(0, 12),
    important_dates: stringArray(facts.important_dates).slice(0, 12),
  };
}

function normalizeSuggestedSources(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((item) => {
    const source = objectValue(item);
    return {
      url: cleanNullable(source.url),
      title: cleanNullable(source.title),
      page_type: cleanNullable(source.page_type) || "other",
      reason: cleanNullable(source.reason),
      confidence: clamp(Number(source.confidence) || 0, 0, 1),
    };
  }).filter((item) => item.url);
}

function safeAbsoluteUrl(value, base) {
  try {
    if (!value) return "";
    return normalizeSourceIntakeUrl(new URL(String(value), base).toString());
  } catch {
    return "";
  }
}

function dedupeLinks(links) {
  const seen = new Set();
  const result = [];
  for (const link of links) {
    const key = canonicalUrlKey(link.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(link);
  }
  return result;
}

function titleFromUrl(value) {
  try {
    const url = new URL(value);
    const part = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || url.hostname);
    return cleanText(part.replace(/[-_]+/g, " ")) || url.hostname;
  } catch {
    return "Source page";
  }
}

function nameSimilarity(left, right) {
  const leftTokens = new Set(tokenizeName(left));
  const rightTokens = new Set(tokenizeName(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function tokenizeName(value) {
  return normalizeAwardName(value).split(" ").filter((token) => token.length > 2 && !["the", "and", "for", "with", "award", "awards", "program", "scholarship", "fellowship", "grant"].includes(token));
}

function confidenceNumber(value) {
  const key = cleanKey(value);
  if (key === "high") return 0.9;
  if (key === "medium") return 0.65;
  return 0.4;
}

function sameCanonicalUrl(left, right) {
  return Boolean(left && right && canonicalUrlKey(left) === canonicalUrlKey(right));
}

function sameHost(left, right) {
  try {
    if (!left || !right) return false;
    return new URL(left).hostname.replace(/^www\./, "") === new URL(right).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

function canonicalUrlKey(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    url.searchParams.sort();
    return url.toString().replace(/\/+$/g, "").toLowerCase();
  } catch {
    return cleanText(value).toLowerCase();
  }
}

function isPrivateIpLikeHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  return /^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) || host === "0.0.0.0" || host === "::1";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArray(value) {
  if (Array.isArray(value)) return value.flatMap((item) => stringArray(item));
  if (typeof value !== "string") return [];
  return value.split(/\s*(?:;|\n|\u2022)\s*/).map(cleanText).filter(Boolean);
}

function cleanChoice(value, choices, fallback) {
  const key = cleanKey(value).replace(/-/g, "_");
  return choices.includes(key) ? key : fallback;
}

function cleanNullable(value) {
  const text = cleanText(value);
  return text || null;
}

function cleanKey(value) {
  return cleanText(value).toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]+/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function cleanText(value) {
  return String(value || "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function truncate(value, maxLength) {
  const clean = cleanText(value);
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(1, maxLength - 3)).replace(/[.,;:\s]+$/g, "")}...`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function positiveInt(value, fallback) {
  const numeric = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
