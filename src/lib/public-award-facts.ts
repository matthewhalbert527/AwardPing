import { awardBaselineSummaryParts, displayAwardSummary } from "@/lib/award-summary";
import type { Json } from "@/lib/database.types";
import { normalizeImportantDateItems } from "@/lib/important-dates";

export type PublicAwardFacts = {
  overview: string | null;
  deadline: string | null;
  openingDate: string | null;
  awardAmount: string | string[] | null;
  eligibility: string[];
  requirements: string[];
  applicationMaterials: string[];
  howToApply: string[];
  importantDates: string[];
  documents: string[];
  contacts: string[];
  academicLevels: string[];
  disciplines: string[];
  citizenship: string[];
  confidence: string | null;
};

export type PublicAwardFactSource = {
  page_metadata?: unknown;
  page_metadata_generated_at?: string | null;
  page_metadata_model?: string | null;
  page_type?: string | null;
  source?: string | null;
  reason?: string | null;
  submitted_by_user_id?: string | null;
  url?: string | null;
  title?: string | null;
  display_title?: string | null;
  page_description?: string | null;
  last_checked_at?: string | null;
};

export function publicAwardFactsFromAward(input: {
  summary?: string | null;
  publicFacts?: Json | null;
  sources?: PublicAwardFactSource[];
}): PublicAwardFacts {
  const structured = objectValue(input.publicFacts);
  // Structured public facts are the reviewed publication (Stage 1: the
  // human-reviewed fact ledger). They render verbatim in the field the review
  // assigned them: no keyword inference, no regex re-categorisation, no
  // truncation, nothing dropped. The heuristics below exist only for the
  // legacy summary-derived path, where no reviewed facts exist.
  const reviewed = Object.keys(structured).length > 0;
  const summaryParts = awardBaselineSummaryParts(input.summary);
  const factMap = new Map(
    (summaryParts?.facts || []).map((fact) => [normalizeLabel(fact.label), fact.value]),
  );
  // Public pages should render the reconciled award-level snapshot. Source
  // baseline facts are intentionally not merged at read time; they flow through
  // the reconciliation worker first so sibling pages cannot contaminate facts.
  const sourceFacts: Array<Record<string, unknown>> = [];

  const field = (value: unknown) => (reviewed ? reviewedArrayField(value) : arrayField(value));
  const eligibility = field(structured.eligibility).length
    ? field(structured.eligibility)
    : splitFact(factMap.get("eligibility") || null, sourceFacts.flatMap((facts) => arrayField(facts.eligibility)));
  const requirements = field(structured.requirements).length
    ? field(structured.requirements)
    : splitFact(factMap.get("requirements") || null, sourceFacts.flatMap((facts) => arrayField(facts.requirements)));
  const applicationMaterials = field(structured.application_materials).length
    ? field(structured.application_materials)
    : splitFact(
        factMap.get("application materials") || null,
        sourceFacts.flatMap((facts) => arrayField(facts.application_materials)),
      );
  const normalizedFacts = reviewed
    ? { requirements, applicationMaterials }
    : normalizeRequirementFacts(requirements, applicationMaterials);
  const documents = field(structured.documents).length
    ? field(structured.documents)
    : splitFact(factMap.get("documents") || null, sourceFacts.flatMap((facts) => arrayField(facts.documents)));
  const rawImportantDates = field(structured.important_dates).length
    ? field(structured.important_dates)
    : splitFact(
        factMap.get("important dates") || null,
        sourceFacts.flatMap((facts) => arrayField(facts.important_dates)),
      );
  const structuredAwardAmounts = field(structured.award_amounts).flatMap(splitFactItems);
  const fallbackAwardAmounts = splitFact(
    factMap.get("award amount") || null,
    sourceFacts.flatMap((facts) => arrayField(facts.award_amounts)),
  );

  const deadline =
    cleanString(structured.deadline) ||
    cleanString(factMap.get("deadline")) ||
    firstValue(sourceFacts.map((facts) => cleanString(facts.deadline)));
  const openingDate =
    cleanString(structured.opening_date) ||
    cleanString(factMap.get("opening date")) ||
    firstValue(sourceFacts.map((facts) => cleanString(facts.opening_date)));
  const importantDates = normalizeImportantDateItems(rawImportantDates, { deadline, openingDate });

  return {
    overview:
      cleanString(structured.overview) ||
      cleanString(structured.summary) ||
      summaryParts?.overview ||
      displayAwardSummary(input.summary) ||
      null,
    deadline,
    openingDate,
    awardAmount: reviewed
      ? listFact(structuredAwardAmounts)
      : compactFact(structuredAwardAmounts.length ? structuredAwardAmounts : fallbackAwardAmounts),
    eligibility,
    requirements: normalizedFacts.requirements,
    applicationMaterials: normalizedFacts.applicationMaterials,
    howToApply: field(structured.how_to_apply).length
      ? field(structured.how_to_apply)
      : splitFact(factMap.get("how to apply") || null, sourceFacts.flatMap((facts) => arrayField(facts.how_to_apply))),
    importantDates,
    documents,
    contacts: field(structured.contacts).length
      ? field(structured.contacts)
      : splitFact(factMap.get("contacts") || null, sourceFacts.flatMap((facts) => arrayField(facts.contacts))),
    // Audience fields are never inferred from other fields' wording: a Gilman
    // requirement about "international insurance coverage including health"
    // once surfaced as "Discipline: Health". Absent from the review = absent
    // from the page.
    academicLevels: field(structured.academic_levels),
    disciplines: field(structured.disciplines),
    citizenship: field(structured.citizenship),
    confidence:
      cleanString(structured.confidence) ||
      cleanString(factMap.get("baseline detail confidence")),
  };
}

export function publicAwardMetaDescription(name: string, facts: PublicAwardFacts) {
  const summary = facts.overview || `${name} award details, official source links, and recent updates.`;
  const deadline = facts.deadline ? ` Deadline: ${facts.deadline}.` : "";
  return truncate(`${summary}${deadline}`, 155);
}

export function latestCheckedAt(sources: Array<{ last_checked_at?: string | null }>) {
  return sources
    .map((source) => source.last_checked_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) || null;
}

function splitFact(value: string | null, fallback: string[] = []) {
  const fallbackItems = fallback.flatMap(splitFactItems);
  if (!value) return uniqueShort(fallbackItems);
  return uniqueShort([...splitFactItems(value), ...fallbackItems]);
}

function compactFact(values: string[]) {
  const clean = uniqueShort(values);
  if (clean.length === 0) return null;
  return clean.length === 1 ? clean[0] : clean;
}

function normalizeRequirementFacts(requirements: string[], applicationMaterials: string[]) {
  const movedMaterials: string[] = [];
  const awardConditions: string[] = [];

  for (const requirement of requirements) {
    if (looksLikeApplicationMaterial(requirement)) {
      movedMaterials.push(requirement);
    } else if (looksLikeAwardCondition(requirement)) {
      awardConditions.push(requirement);
    }
  }

  return {
    requirements: uniqueSemanticItems(awardConditions),
    applicationMaterials: uniqueSemanticItems([...movedMaterials, ...applicationMaterials]),
  };
}

function looksLikeApplicationMaterial(value: string) {
  const text = value.toLowerCase();

  return (
    (/\b(transcripts?|references?|recommendations?|recommendation letters?|letters? of recommendation|letters? of intent|loi|personal statements?|research statements?|supporting statements?|statements?|essays?|forms?|application form|scholarship application|application packet|online application|application submission|application portal|upload(?:ed|s|ing)?|resume|cv|curriculum vitae|portfolio|writing sample|proposal|abstract|budget|work samples?|test scores?|gre|toefl|ielts)\b/.test(
      text,
    ) ||
      /\b(questions?|section [a-z0-9]|sections? of the|contact information|career interests?|college information|tuition and living expenses|sources? of funding|college academic honors?|extracurricular activities)\b/.test(
        text,
      )) &&
    !/\b(research topic|research priorities|academic performance|demonstrated interest|full[- ]time|citizenship|resident|gpa requirement|eligible|ineligible|must be enrolled|degree program|field of study)\b/.test(
      text,
    )
  );
}

function looksLikeAwardCondition(value: string) {
  const text = value.toLowerCase();

  if (
    /\b(academic performance|potential for success|relevance of work|selection criteria|review criteria|evaluation criteria|demonstrated interest|research topic|research priorities|fit with .*mission|fit within .*priorities)\b/.test(
      text,
    )
  ) {
    return false;
  }

  if (
    /\b(full[- ]time|master'?s|doctoral|undergraduate|graduate|citizens?|resident|gpa|field of study|degree program|enrolled)\b/.test(
      text,
    ) &&
    !/\b(maintain|remain|continue|during|through|throughout|award year|award period|funding period)\b/.test(
      text,
    )
  ) {
    return false;
  }

  const specificCompletionCondition =
    /\b(complete|completion)\b.*\b(final report|progress report|program|training|residency|orientation|workshop|conference|service|internship|fellowship|project)\b/.test(
      text,
    );

  return (
    specificCompletionCondition ||
    /\b(attend|attendance|participate|participation|serve|service|report|progress report|final report|residency|orientation|workshop|conference|commit|commitment|obligation|maintain|remain|continue|throughout|during the award|award period|award year|may not|cannot|can not|must not|not hold|hold another|concurrent|simultaneous)\b/.test(
      text,
    ) ||
    /\brecipients?\s+must\b/.test(text) ||
    /\bawardees?\s+must\b/.test(text) ||
    /\bfellows?\s+must\b/.test(text)
  );
}

function uniqueSemanticItems(values: string[]) {
  const seen = new Map<string, string>();

  for (const value of values.map(cleanString).filter(Boolean)) {
    const key = semanticItemKey(value);
    const existing = seen.get(key);
    if (!existing || value.length > existing.length) {
      seen.set(key, truncate(value, 180));
    }
  }

  return [...seen.values()].slice(0, 10);
}

function semanticItemKey(value: string) {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(required|required\.|must be submitted|must submit|submitted|submission|upload(?:ed)?|complete(?:d)?|the|a|an)\b/g, " ")
    .replace(/\breferences\b/g, "reference")
    .replace(/\brecommendations\b/g, "recommendation")
    .replace(/\btranscripts\b/g, "transcript")
    .replace(/\bstatements\b/g, "statement")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function splitFactItems(value: string) {
  return value.split(/\s*;\s*/).map((item) => item.trim()).filter(Boolean);
}

function arrayField(value: unknown) {
  if (!Array.isArray(value)) return [];
  return uniqueShort(value.map(cleanString).filter(Boolean));
}

// Reviewed values: exact-duplicate removal only. No 180-character truncation
// and no ten-item cap - every reviewed item reaches the page intact.
function reviewedArrayField(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value.map(cleanString).filter(Boolean)) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function listFact(values: string[]) {
  const clean = values.map(cleanString).filter(Boolean);
  if (clean.length === 0) return null;
  return clean.length === 1 ? clean[0] : clean;
}

function firstValue(values: Array<string | null | undefined>) {
  return values.map(cleanString).find(Boolean) || null;
}

function uniqueShort(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(cleanString).filter(Boolean)) {
    const key = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(truncate(value, 180));
  }
  return result.slice(0, 10);
}

function normalizeLabel(value: string) {
  return value.trim().toLowerCase();
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function truncate(value: string, length: number) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= length) return clean;
  return `${clean.slice(0, length - 1).replace(/\s+\S*$/, "")}...`;
}
