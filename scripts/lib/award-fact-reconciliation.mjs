import { sourceBaselineFacts, sourceQualityDecision } from "./source-quality.mjs";

const fieldAliases = {
  display_title: "source_titles",
  description: "overview",
  overview: "overview",
  page_description: "overview",
  deadline: "deadline",
  opening_date: "opening_date",
  cycle_status: "cycle_status",
  award_amount: "award_amounts",
  award_amounts: "award_amounts",
  stipend: "stipend",
  travel_research_allowance: "travel_research_allowance",
  tenure: "tenure",
  academic_level: "academic_levels",
  academic_levels: "academic_levels",
  discipline: "disciplines",
  disciplines: "disciplines",
  citizenship: "citizenship",
  eligibility: "eligibility",
  requirements: "requirements",
  award_conditions: "requirements",
  application_materials: "application_materials",
  how_to_apply: "how_to_apply",
  important_dates: "important_dates",
  documents: "documents",
  contact: "contacts",
  contacts: "contacts",
  source_titles: "source_titles",
  official_homepage_url: "official_homepage_url",
  application_url: "application_url",
  faq_url: "faq_url",
};

const listFields = new Set([
  "award_amounts",
  "academic_levels",
  "disciplines",
  "citizenship",
  "eligibility",
  "requirements",
  "application_materials",
  "how_to_apply",
  "important_dates",
  "documents",
  "contacts",
  "source_titles",
]);
const criticalConflictFields = new Set(["deadline", "opening_date", "cycle_status", "award_amounts", "stipend", "travel_research_allowance"]);
const primaryOnlyFields = new Set(["source_titles", "overview", "official_homepage_url"]);
const applicationAllowedFields = new Set(["deadline", "opening_date", "application_materials", "how_to_apply", "application_url", "important_dates"]);
const faqAllowedFields = new Set(["overview", "deadline", "opening_date", "award_amounts", "stipend", "travel_research_allowance", "eligibility", "application_materials", "how_to_apply", "important_dates", "contacts", "faq_url"]);
const eligibilityAllowedFields = new Set(["eligibility", "citizenship", "academic_levels", "disciplines", "requirements"]);
const requirementsAllowedFields = new Set(["requirements", "application_materials", "documents", "how_to_apply"]);
const identityStopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "program",
  "programs",
  "scholarship",
  "scholarships",
  "fellowship",
  "fellowships",
  "grant",
  "grants",
  "award",
  "awards",
  "application",
  "applications",
  "apply",
  "foundation",
  "institute",
  "university",
  "college",
  "students",
]);
const genericSourcePattern = /\b(search results?|listing|directory|database|find programs?|program search|recipient|awardee|profile|news|event|calendar|career|job|payment|bursar|security question|access denied|login)\b/i;

export function normalizeAwardName(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeFieldValue(value) {
  if (Array.isArray(value)) return uniqueStrings(value.flatMap((item) => splitFactItems(item))).map(normalizeText).filter(Boolean);
  if (value && typeof value === "object") return value;
  const text = normalizeText(value).replace(/[.;:\s]+$/g, "");
  return text || null;
}

export function awardIdentityScore(award, source, extractedFacts = sourceBaselineFacts(source)) {
  const awardTokens = identityTokens(award?.name);
  if (!awardTokens.length) return 0;
  const sourceText = [
    source?.title,
    source?.display_title,
    source?.page_description,
    source?.url,
    extractedFacts.display_title,
    extractedFacts.award_name_seen,
    extractedFacts.page_description,
    ...arrayField(extractedFacts.evidence_quotes),
  ].join(" ");
  const sourceTokens = new Set(identityTokens(sourceText));
  const overlap = awardTokens.filter((token) => sourceTokens.has(token)).length;
  let score = overlap / awardTokens.length;
  const relevance = cleanKey(extractedFacts.award_relevance);
  if (relevance === "primary") score += 0.25;
  if (relevance === "supporting") score += 0.12;
  if (sameCanonicalUrl(award?.official_homepage, source?.url)) score += 0.2;
  if (looksLikeSiblingProgram(award, sourceText)) score -= 0.45;
  if (genericSourcePattern.test(sourceText)) score -= 0.15;
  return clamp(score, 0, 1);
}

export function sourceCanContributeField(source, fieldName, award) {
  if (!source) return false;
  const quality = sourceQualityDecision(source, { purpose: "facts" });
  if (!quality.allowed) return false;
  const facts = sourceBaselineFacts(source);
  if (awardIdentityScore(award, source, facts) < 0.35) return false;
  const field = canonicalFieldName(fieldName);
  const pageType = cleanKey(source.page_type);
  const relevance = cleanKey(facts.award_relevance);
  const sourceText = `${source.url || ""} ${source.title || ""} ${source.display_title || ""} ${facts.display_title || ""}`;
  if (genericSourcePattern.test(sourceText)) return false;
  if (primaryOnlyFields.has(field)) {
    return relevance === "primary" && ["homepage", "deadline", "eligibility", "requirements", "faq"].includes(pageType);
  }
  if (pageType === "application") return applicationAllowedFields.has(field);
  if (pageType === "faq") return faqAllowedFields.has(field);
  if (pageType === "eligibility") return eligibilityAllowedFields.has(field);
  if (pageType === "requirements") return requirementsAllowedFields.has(field);
  if (pageType === "deadline") return ["deadline", "opening_date", "cycle_status", "important_dates"].includes(field);
  if (pageType === "pdf") return !["overview", "source_titles"].includes(field);
  return relevance === "primary" || !primaryOnlyFields.has(field);
}

export function validateFactCandidate(candidate, award, source) {
  const field = canonicalFieldName(candidate.field_name);
  const value = normalizeFieldValue(candidate.raw_value);
  if (value === null || (Array.isArray(value) && value.length === 0)) return { allowed: false, reason: "empty_value", value, field };
  if (!sourceCanContributeField(source, field, award)) return { allowed: false, reason: explainFactRejection(candidate, source || null, award), value, field };
  const evidence = cleanEvidence(candidate.evidence_quote) || cleanEvidence(sourceBaselineFacts(source).evidence_quotes);
  if (!evidence && !["official_homepage_url", "application_url", "faq_url"].includes(field)) return { allowed: false, reason: "missing_exact_evidence", value, field };
  const text = normalizeText(Array.isArray(value) ? value.join(" ") : value);
  if ((field === "overview" || field === "source_titles") && looksLikeSiblingProgram(award, text)) {
    return { allowed: false, reason: "sibling_program_identity_mismatch", value, field };
  }
  return { allowed: true, reason: "accepted", value, field };
}

export function reconcileAwardFacts(award, sources, candidates = [], options = {}) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const sourceRejections = [];
  for (const source of sources) {
    const quality = sourceQualityDecision(source, { purpose: "facts" });
    if (!quality.allowed) sourceRejections.push({ source, reason: quality.reason });
  }
  const allCandidates = candidates.length ? candidates : buildFactCandidatesFromSources(award, sources);
  const acceptedByField = new Map();
  const rejected = [];
  for (const candidate of allCandidates) {
    const source = sourceById.get(candidate.shared_award_source_id || "") || sourceForCandidate(candidate, sources);
    const validation = validateFactCandidate(candidate, award, source);
    if (!validation.allowed) {
      rejected.push({ candidate, source: source || null, reason: validation.reason });
      continue;
    }
    const selection = {
      candidate: { ...candidate, field_name: validation.field },
      source: source || null,
      value: validation.value,
      reason: explainFactSelection(candidate, source || null, award),
      score: factCandidateScore(candidate, source || null, award),
    };
    acceptedByField.set(validation.field, [...(acceptedByField.get(validation.field) || []), selection]);
  }
  const selected = {};
  const conflicts = [];
  for (const [field, selections] of acceptedByField.entries()) {
    const groups = groupSelectionsByNormalizedValue(field, selections);
    if (groups.length > 1) {
      conflicts.push({
        field_name: field,
        severity: criticalConflictFields.has(field) ? "critical" : "warning",
        values: selections.map((selection) => ({ value: selection.value, candidate: selection.candidate, source: selection.source })),
        reason: "incompatible_values",
      });
    }
    selected[field] = [...selections].sort((left, right) => right.score - left.score)[0];
  }
  return {
    selectedFacts: selectedFactsFromSelections(award, selected, {
      now: options.now,
      generatedAt: options.generatedAt,
      rejectedCount: rejected.length,
      conflictCount: conflicts.length,
    }),
    selected,
    rejected,
    conflicts,
    candidates: allCandidates,
    sourceRejections,
  };
}

export function auditPublicAwardPage(award, selectedFacts, sources, options = {}) {
  const findings = [];
  const suggested_fixes = [];
  const reconciliation = options.reconciliation;
  if (!selectedFacts.overview) findings.push({ code: "missing_description", severity: "warning", message: "No award-specific description was selected." });
  else if (looksLikeSiblingProgram(award, selectedFacts.overview)) findings.push({ code: "description_mentions_sibling_award", severity: "critical", message: "Selected description appears to describe another award.", field_name: "overview" });
  if (selectedFacts.deadline && !selectionHasEvidence(reconciliation?.selected?.deadline)) findings.push({ code: "deadline_missing_evidence", severity: "critical", message: "Selected deadline does not have exact source evidence.", field_name: "deadline" });
  for (const conflict of reconciliation?.conflicts || []) findings.push({ code: "field_conflict", severity: conflict.severity === "critical" ? "critical" : "warning", message: `Conflicting ${conflict.field_name} values remain unresolved.`, field_name: conflict.field_name });
  for (const item of selectedFacts.important_dates || []) {
    if (isBareDateValue(item)) {
      findings.push({ code: "bare_important_date", severity: "error", message: "Important dates must include context labels.", field_name: "important_dates" });
      suggested_fixes.push({ field_name: "important_dates", reason: "remove_or_label_bare_date", value: item });
    }
  }
  const officialAmountCandidates = (reconciliation?.candidates || []).filter((candidate) => {
    const source = sourceForCandidate(candidate, sources);
    return canonicalFieldName(candidate.field_name) === "award_amounts" && sourceCanContributeField(source, "award_amounts", award);
  });
  if (!(selectedFacts.award_amounts || []).length && officialAmountCandidates.length) {
    findings.push({
      code: "missing_amount_with_official_evidence",
      severity: "warning",
      message: "An official award-specific source contains amount evidence, but no amount was selected. Keep any last-known-good amount and review it without blocking other verified fields.",
      field_name: "award_amounts",
    });
    suggested_fixes.push({ field_name: "award_amounts", reason: "review_official_amount_evidence" });
  }
  const severity = maxFindingSeverity(findings);
  const shouldBlock = severity === "critical" || severity === "error";
  return {
    audit_status: shouldBlock ? "failed" : findings.length ? "warnings" : "passed",
    severity,
    findings,
    suggested_fixes,
    field_conflicts: reconciliation?.conflicts || [],
    source_rejections: (reconciliation?.sourceRejections || []).map((item) => ({ source_id: item.source.id || null, reason: item.reason })),
    selected_fact_summary: compactSelectedFactSummary(selectedFacts),
    should_block_publication: shouldBlock,
  };
}

export function explainFactSelection(candidate, source, award) {
  const facts = sourceBaselineFacts(source);
  return `selected_${canonicalFieldName(candidate.field_name)}_${cleanKey(facts.award_relevance) || "unknown"}_identity_${awardIdentityScore(award, source, facts).toFixed(2)}`;
}

export function explainFactRejection(candidate, source, award) {
  if (!source) return "missing_source";
  const quality = sourceQualityDecision(source, { purpose: "facts" });
  if (!quality.allowed) return `source_quality_${quality.reason}`;
  if (awardIdentityScore(award, source, sourceBaselineFacts(source)) < 0.35) return "sibling_program_identity_mismatch";
  if (genericSourcePattern.test(`${source.url || ""} ${source.title || ""} ${source.display_title || ""}`)) return "generic_or_broad_source_not_field_specific";
  return `field_not_allowed_for_source_role_${canonicalFieldName(candidate.field_name)}`;
}

export function buildFactCandidatesFromSources(award, sources) {
  const candidates = [];
  for (const source of sources) {
    const facts = sourceBaselineFacts(source);
    const evidence = cleanEvidence(facts.evidence_quotes);
    const add = (field, value) => {
      const normalizedField = canonicalFieldName(field);
      if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) return;
      candidates.push({
        shared_award_id: award.id,
        shared_award_source_id: source.id || null,
        source_url: source.url || null,
        source_title: source.display_title || source.title || null,
        source_role: cleanKey(facts.award_relevance) || null,
        field_name: normalizedField,
        raw_value: value,
        normalized_value: normalizeFieldValue(value),
        evidence_quote: evidence || firstEvidenceForValue(value, facts),
        evidence_location: cleanString(facts.evidence_location) || null,
        extracted_at: source.page_metadata_generated_at || null,
        model: source.page_metadata_model || null,
        confidence: cleanKey(facts.confidence) || null,
        candidate_status: "pending",
        metadata: {
          source_page_type: source.page_type || null,
          source_quality_decision: sourceQualityDecision(source, { purpose: "facts" }),
        },
      });
    };
    add("description", facts.page_description || source.page_description);
    add("display_title", facts.display_title || facts.award_name_seen || source.display_title || source.title);
    add("deadline", facts.deadline);
    add("opening_date", facts.opening_date);
    add("cycle_status", inferCycleStatus(facts, { now: new Date() }));
    add("award_amount", facts.award_amounts || facts.award_amount);
    add("stipend", facts.stipend);
    add("travel_research_allowance", facts.travel_research_allowance);
    add("tenure", facts.tenure);
    add("academic_level", facts.academic_levels || facts.academic_level);
    add("discipline", facts.disciplines || facts.discipline);
    add("citizenship", facts.citizenship);
    add("eligibility", facts.eligibility);
    add("requirements", facts.requirements || facts.award_conditions);
    add("application_materials", facts.application_materials);
    add("how_to_apply", facts.how_to_apply);
    add("important_dates", facts.important_dates);
    add("documents", facts.documents);
    add("contact", facts.contacts || facts.contact);
    if (sameCanonicalUrl(award.official_homepage, source.url) || cleanKey(source.page_type) === "homepage") add("official_homepage_url", source.url);
    if (cleanKey(source.page_type) === "application") add("application_url", source.url);
    if (cleanKey(source.page_type) === "faq") add("faq_url", source.url);
  }
  return candidates;
}

export function buildAwardSummaryFromFacts(award, facts) {
  const parts = [ensureSentencePunctuation(facts.overview || `${award.name} award details from reconciled official sources.`)];
  addFact(parts, "Deadline", facts.deadline);
  addFact(parts, "Opening date", facts.opening_date);
  addFact(parts, "Cycle status", facts.cycle_status);
  addFact(parts, "Award amount", facts.award_amounts);
  addFact(parts, "Eligibility", facts.eligibility);
  addFact(parts, "Award conditions", facts.requirements);
  addFact(parts, "Application materials", facts.application_materials);
  addFact(parts, "How to apply", facts.how_to_apply);
  addFact(parts, "Important dates", facts.important_dates);
  addFact(parts, "Documents", facts.documents);
  addFact(parts, "Contacts", facts.contacts);
  parts.push(`Baseline detail confidence: ${facts.confidence || "medium"}.`);
  return truncate(parts.filter(Boolean).join(" "), 2800);
}

export function preserveLastKnownGoodAmountFacts(selectedFacts, previousPublicFacts) {
  const previous = objectRecord(previousPublicFacts);
  const previousAwardAmounts = uniqueStrings(arrayField(previous.award_amounts ?? previous.award_amount));
  const previousStipend = cleanString(previous.stipend) || null;
  const previousAllowance = cleanString(previous.travel_research_allowance) || null;
  const preservedFields = [];
  let awardAmounts = selectedFacts.award_amounts || [];
  let stipend = selectedFacts.stipend || null;
  let travelResearchAllowance = selectedFacts.travel_research_allowance || null;

  if (!awardAmounts.length && previousAwardAmounts.length) {
    awardAmounts = previousAwardAmounts;
    preservedFields.push("award_amounts");
  }
  if (!stipend && previousStipend) {
    stipend = previousStipend;
    preservedFields.push("stipend");
  }
  if (!travelResearchAllowance && previousAllowance) {
    travelResearchAllowance = previousAllowance;
    preservedFields.push("travel_research_allowance");
  }
  if (!preservedFields.length) return selectedFacts;

  return {
    ...selectedFacts,
    award_amounts: awardAmounts,
    stipend,
    travel_research_allowance: travelResearchAllowance,
    reconciliation: {
      ...selectedFacts.reconciliation,
      preserved_fields: uniqueStrings([
        ...(selectedFacts.reconciliation?.preserved_fields || []),
        ...preservedFields,
      ]),
      review_flags: uniqueStrings([
        ...(selectedFacts.reconciliation?.review_flags || []),
        "amount_preserved_pending_review",
      ]),
    },
  };
}

export async function enqueueAwardReconciliation(supabase, { awardId, reason, sourceIds = [], candidateIds = [], priority = 100, metadata = {} }) {
  if (!awardId) return { queued: false, reason: "missing_award_id" };
  const payload = {
    shared_award_id: awardId,
    reason,
    source_ids: unique(sourceIds).filter(Boolean),
    candidate_ids: unique(candidateIds).filter(Boolean),
    status: "pending",
    priority,
    metadata,
  };
  const { data, error } = await supabase
    .from("shared_award_reconciliation_queue")
    .upsert(payload, { onConflict: "shared_award_id,reason,status", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (error) {
    if (/does not exist|schema cache|relation .* not found/i.test(error.message || "")) return { queued: false, reason: "queue_table_missing" };
    throw new Error(`Queue award reconciliation failed: ${error.message}`);
  }
  return { queued: Boolean(data?.id), id: data?.id || null };
}

function selectedFactsFromSelections(award, selected, options) {
  const get = (field) => selected[field]?.value;
  const list = (field, limit = 10) => uniqueStrings(arrayField(get(field))).slice(0, limit);
  const deadline = cleanString(get("deadline")) || null;
  const openingDate = cleanString(get("opening_date")) || null;
  return {
    overview: cleanString(get("overview")) || null,
    deadline,
    opening_date: openingDate,
    cycle_status: canonicalCycleStatus(get("cycle_status"), { deadline, now: options.now }),
    award_amounts: list("award_amounts", 10),
    stipend: cleanString(get("stipend")) || null,
    travel_research_allowance: cleanString(get("travel_research_allowance")) || null,
    tenure: cleanString(get("tenure")) || null,
    academic_levels: list("academic_levels", 8),
    disciplines: list("disciplines", 8),
    citizenship: list("citizenship", 8),
    eligibility: list("eligibility", 12),
    requirements: list("requirements", 10),
    application_materials: list("application_materials", 12),
    how_to_apply: list("how_to_apply", 10),
    important_dates: normalizeImportantDates(list("important_dates", 15), { deadline, openingDate }).slice(0, 10),
    documents: list("documents", 10),
    contacts: list("contacts", 8),
    source_titles: list("source_titles", 20),
    official_homepage_url: cleanString(get("official_homepage_url")) || award.official_homepage || null,
    application_url: cleanString(get("application_url")) || null,
    faq_url: cleanString(get("faq_url")) || null,
    confidence: aggregateSelectionConfidence(selected),
    reconciliation: {
      model: "award-fact-reconciliation",
      generated_at: options.generatedAt || new Date().toISOString(),
      selected_candidate_ids: Object.values(selected).map((item) => item.candidate.id).filter(Boolean),
      rejected_count: options.rejectedCount,
      conflict_count: options.conflictCount,
    },
  };
}

function factCandidateScore(candidate, source, award) {
  const facts = sourceBaselineFacts(source);
  let score = awardIdentityScore(award, source, facts) * 100;
  const relevance = cleanKey(facts.award_relevance);
  if (relevance === "primary") score += 30;
  if (relevance === "supporting") score += 10;
  const pageType = cleanKey(source?.page_type);
  if (pageType === "homepage") score += 12;
  if (pageType === "deadline" && canonicalFieldName(candidate.field_name) === "deadline") score += 15;
  if (pageType === "application" && applicationAllowedFields.has(canonicalFieldName(candidate.field_name))) score += 8;
  if (cleanKey(candidate.confidence || facts.confidence) === "high") score += 8;
  if (candidate.evidence_quote) score += 5;
  return score;
}

function canonicalFieldName(value) {
  const key = cleanKey(value).replace(/-/g, "_");
  return String(fieldAliases[key] || key);
}

function inferCycleStatus(facts, context) {
  const cycle = cleanKey(facts.cycle_status);
  if (cycle) return canonicalCycleStatus(cycle, { deadline: cleanString(facts.deadline), now: context.now });
  const relevance = cleanKey(facts.cycle_relevance);
  if (relevance === "archived-or-past" || relevance === "not-program-page") return "archived_or_information_only";
  return canonicalCycleStatus(null, { deadline: cleanString(facts.deadline), now: context.now });
}

function canonicalCycleStatus(value, context = {}) {
  const key = cleanKey(value).replace(/-/g, "_");
  if (["open", "upcoming", "deadline_passed", "archived_or_information_only", "unknown", "rolling", "temporarily_closed", "next_cycle_not_announced"].includes(key)) return key;
  if (["closed", "passed", "deadlinepassed"].includes(key)) return "deadline_passed";
  if (["archived", "past", "information_only", "info_only"].includes(key)) return "archived_or_information_only";
  const deadlineDate = parseDateLike(context.deadline);
  const now = context.now ? new Date(context.now) : new Date();
  if (deadlineDate && Number.isFinite(now.getTime())) return deadlineDate.getTime() < startOfDay(now).getTime() ? "deadline_passed" : "upcoming";
  return "unknown";
}

function groupSelectionsByNormalizedValue(field, selections) {
  const groups = new Map();
  for (const selection of selections) {
    const key = normalizedConflictKey(field, selection.value);
    groups.set(key, [...(groups.get(key) || []), selection]);
  }
  return [...groups.values()];
}

function normalizedConflictKey(field, value) {
  const values = arrayField(value).map((item) => item.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).filter(Boolean);
  if (field === "deadline" || field === "opening_date") {
    const parsed = values.map((item) => parseDateLike(item)?.toISOString().slice(0, 10)).find(Boolean);
    if (parsed) return parsed;
  }
  if (listFields.has(field)) return values.sort().join("|");
  return values.join(" ");
}

function sourceForCandidate(candidate, sources) {
  if (candidate.shared_award_source_id) {
    const byId = sources.find((source) => source.id === candidate.shared_award_source_id);
    if (byId) return byId;
  }
  const sourceUrl = canonicalUrlKey(candidate.source_url);
  return sources.find((source) => canonicalUrlKey(source.url) === sourceUrl) || null;
}

function selectionHasEvidence(selection) {
  if (!selection) return false;
  return Boolean(cleanEvidence(selection.candidate.evidence_quote) || cleanEvidence(sourceBaselineFacts(selection.source).evidence_quotes));
}

function compactSelectedFactSummary(facts) {
  return {
    overview: facts.overview,
    deadline: facts.deadline,
    opening_date: facts.opening_date,
    cycle_status: facts.cycle_status,
    award_amounts: facts.award_amounts,
    application_materials_count: facts.application_materials?.length || 0,
    eligibility_count: facts.eligibility?.length || 0,
  };
}

function normalizeImportantDates(values, context) {
  const result = [];
  for (const value of values) {
    const clean = normalizeText(value);
    if (!clean) continue;
    if (!isBareDateValue(clean)) result.push(clean);
    else if (sameDateText(clean, context.deadline)) result.push(`Application deadline: ${clean}`);
    else if (sameDateText(clean, context.openingDate)) result.push(`Applications open: ${clean}`);
  }
  return uniqueStrings(result);
}

function isBareDateValue(value) {
  const stripped = normalizeText(value)
    .toLowerCase()
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g, " ")
    .replace(/\b(?:spring|summer|fall|autumn|winter|early|mid|late|end|beginning|start|through|to|and|or|of|the|by|on|at)\b/g, " ")
    .replace(/\b\d{1,4}(?:st|nd|rd|th)?\b/g, " ")
    .replace(/[,\-/().:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length === 0 && /\d/.test(value);
}

function sameDateText(value, reference) {
  const left = normalizeDateText(value);
  const right = normalizeDateText(reference || "");
  return Boolean(left && right && (left === right || right.includes(left) || left.includes(right)));
}

function normalizeDateText(value) {
  return normalizeText(value).toLowerCase().replace(/\b(?:deadline|due|opens?|opening|applications?|application|date|by|on|at)\b/g, " ").replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, "$1").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseDateLike(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
}

function startOfDay(value) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function aggregateSelectionConfidence(selected) {
  const confidences = Object.values(selected).map((selection) => cleanKey(selection.candidate.confidence || sourceBaselineFacts(selection.source).confidence));
  if (confidences.includes("high")) return "high";
  if (confidences.includes("medium")) return "medium";
  return Object.keys(selected).length ? "medium" : "low";
}

function maxFindingSeverity(findings) {
  const order = ["info", "warning", "error", "critical"];
  let max = "info";
  for (const finding of findings) if (order.indexOf(finding.severity) > order.indexOf(max)) max = finding.severity;
  return max;
}

function looksLikeSiblingProgram(award, value) {
  const text = normalizeAwardName(value);
  if (!text) return false;
  const awardTokens = identityTokens(award?.name);
  const titleMatch = text.match(/\b([a-z0-9 ]{4,90}(?:prize|prizes|scholarship|fellowship|grant|award|program)s?)\b/);
  if (!titleMatch) return false;
  const candidateTokens = identityTokens(titleMatch[1]);
  if (candidateTokens.length < 2) return false;
  const overlap = candidateTokens.filter((token) => awardTokens.includes(token)).length;
  return overlap / Math.max(1, Math.min(candidateTokens.length, awardTokens.length)) < 0.25;
}

function identityTokens(value) {
  return normalizeAwardName(value).split(" ").filter((token) => token.length > 2 && !identityStopWords.has(token)).slice(0, 30);
}

function arrayField(value) {
  if (Array.isArray(value)) return value.flatMap((item) => arrayField(item));
  const clean = cleanString(value);
  return clean ? splitFactItems(clean) : [];
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function splitFactItems(value) {
  return normalizeText(value).split(/\s*;\s*/).map((item) => item.trim()).filter(Boolean);
}

function firstEvidenceForValue(value, facts) {
  const raw = arrayField(value)[0];
  const evidence = arrayField(facts.evidence_quotes).find((quote) => raw && quote.toLowerCase().includes(raw.toLowerCase().slice(0, 32)));
  return evidence || cleanEvidence(facts.evidence_quotes);
}

function cleanEvidence(value) {
  if (Array.isArray(value)) return cleanEvidence(value.find(Boolean));
  const clean = cleanString(value);
  return clean ? truncate(clean, 240) : null;
}

function cleanString(value) {
  return typeof value === "string" ? normalizeText(value) : value === null || value === undefined ? "" : normalizeText(String(value));
}

function cleanKey(value) {
  return normalizeText(value).toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]+/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeText(value) {
  return String(value || "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(cleanString).filter(Boolean)) {
    const key = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(truncate(value, 220));
  }
  return result;
}

function canonicalUrlKey(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    url.searchParams.sort();
    return url.toString().replace(/\/+$/g, "").toLowerCase();
  } catch {
    return normalizeText(value).toLowerCase();
  }
}

function sameCanonicalUrl(left, right) {
  return Boolean(left && right && canonicalUrlKey(left) === canonicalUrlKey(right));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ensureSentencePunctuation(value) {
  const clean = normalizeText(value);
  if (!clean) return "";
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function addFact(parts, label, value) {
  const values = arrayField(value).filter(Boolean);
  if (!values.length) return;
  parts.push(`${label}: ${ensureSentencePunctuation(truncate(values.join("; "), 500))}`);
}

function truncate(value, maxLength) {
  const clean = normalizeText(value);
  if (clean.length <= maxLength) return clean;
  const target = Math.max(1, maxLength - 3);
  const boundary = clean.lastIndexOf(" ", target);
  return `${clean.slice(0, boundary > target * 0.65 ? boundary : target).replace(/[.,;:\s]+$/g, "")}...`;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}
