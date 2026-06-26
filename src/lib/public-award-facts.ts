import { awardBaselineSummaryParts, displayAwardSummary } from "@/lib/award-summary";
import type { Json } from "@/lib/database.types";

export type PublicAwardFacts = {
  overview: string | null;
  deadline: string | null;
  openingDate: string | null;
  awardAmount: string | null;
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
  page_description?: string | null;
  last_checked_at?: string | null;
};

export function publicAwardFactsFromAward(input: {
  summary?: string | null;
  publicFacts?: Json | null;
  sources?: PublicAwardFactSource[];
}): PublicAwardFacts {
  const structured = objectValue(input.publicFacts);
  const summaryParts = awardBaselineSummaryParts(input.summary);
  const factMap = new Map(
    (summaryParts?.facts || []).map((fact) => [normalizeLabel(fact.label), fact.value]),
  );
  const sourceFacts = (input.sources || [])
    .map((source) => baselineFactsFromMetadata(source.page_metadata))
    .filter((facts) => Object.keys(facts).length > 0);

  const eligibility = arrayField(structured.eligibility).length
    ? arrayField(structured.eligibility)
    : splitFact(factMap.get("eligibility") || null, sourceFacts.flatMap((facts) => arrayField(facts.eligibility)));
  const requirements = arrayField(structured.requirements).length
    ? arrayField(structured.requirements)
    : splitFact(factMap.get("requirements") || null, sourceFacts.flatMap((facts) => arrayField(facts.requirements)));
  const applicationMaterials = arrayField(structured.application_materials).length
    ? arrayField(structured.application_materials)
    : splitFact(
        factMap.get("application materials") || null,
        sourceFacts.flatMap((facts) => arrayField(facts.application_materials)),
      );
  const documents = arrayField(structured.documents).length
    ? arrayField(structured.documents)
    : splitFact(factMap.get("documents") || null, sourceFacts.flatMap((facts) => arrayField(facts.documents)));
  const importantDates = arrayField(structured.important_dates).length
    ? arrayField(structured.important_dates)
    : splitFact(
        factMap.get("important dates") || null,
        sourceFacts.flatMap((facts) => arrayField(facts.important_dates)),
      );

  return {
    overview:
      cleanString(structured.overview) ||
      cleanString(structured.summary) ||
      summaryParts?.overview ||
      displayAwardSummary(input.summary) ||
      null,
    deadline:
      cleanString(structured.deadline) ||
      cleanString(factMap.get("deadline")) ||
      firstValue(sourceFacts.map((facts) => cleanString(facts.deadline))),
    openingDate:
      cleanString(structured.opening_date) ||
      cleanString(factMap.get("opening date")) ||
      firstValue(sourceFacts.map((facts) => cleanString(facts.opening_date))),
    awardAmount:
      firstValue(arrayField(structured.award_amounts)) ||
      cleanString(factMap.get("award amount")) ||
      firstValue(sourceFacts.flatMap((facts) => arrayField(facts.award_amounts))),
    eligibility,
    requirements,
    applicationMaterials,
    howToApply: arrayField(structured.how_to_apply).length
      ? arrayField(structured.how_to_apply)
      : splitFact(factMap.get("how to apply") || null, sourceFacts.flatMap((facts) => arrayField(facts.how_to_apply))),
    importantDates,
    documents,
    contacts: arrayField(structured.contacts).length
      ? arrayField(structured.contacts)
      : splitFact(factMap.get("contacts") || null, sourceFacts.flatMap((facts) => arrayField(facts.contacts))),
    academicLevels: arrayField(structured.academic_levels).length
      ? arrayField(structured.academic_levels)
      : inferAcademicLevels([...eligibility, ...requirements]),
    disciplines: arrayField(structured.disciplines).length
      ? arrayField(structured.disciplines)
      : inferDisciplines([...eligibility, ...requirements, ...documents]),
    citizenship: arrayField(structured.citizenship).length
      ? arrayField(structured.citizenship)
      : inferCitizenship([...eligibility, ...requirements]),
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

function baselineFactsFromMetadata(value: unknown) {
  const metadata = objectValue(value);
  if (
    metadata.baseline_facts_rejected === true ||
    objectValue(metadata.baseline_facts_metadata).rejected === true
  ) {
    return {};
  }

  return objectValue(metadata.baseline_facts || metadata.baselineFacts);
}

function splitFact(value: string | null, fallback: string[] = []) {
  if (!value) return uniqueShort(fallback);
  return uniqueShort([...value.split(/\s*;\s*/), ...fallback]);
}

function arrayField(value: unknown) {
  if (!Array.isArray(value)) return [];
  return uniqueShort(value.map(cleanString).filter(Boolean));
}

function inferAcademicLevels(values: string[]) {
  const text = values
    .join(" ")
    .toLowerCase()
    .replace(/\bundergraduate transcripts?\b/g, "")
    .replace(/\bbachelor'?s? transcripts?\b/g, "");
  const levels: string[] = [];
  if (/\b(first-year|freshman|sophomore|junior|senior|undergraduate|bachelor)/.test(text)) levels.push("Undergraduate");
  if (/\bgraduate|master|doctoral|phd|ph\.d|postdoctoral|postdoc/.test(text)) levels.push("Graduate");
  if (/\bpostdoctoral|postdoc/.test(text)) levels.push("Postdoctoral");
  return levels;
}

function inferDisciplines(values: string[]) {
  const text = values.join(" ").toLowerCase();
  const disciplines: string[] = [];
  if (/\b(ecology|evolution|biology|life sciences?)\b/.test(text)) disciplines.push("Life sciences");
  if (/\b(stem|science|engineering|mathematics|technology|computer|biology|chemistry|physics)\b/.test(text)) disciplines.push("STEM");
  if (/\bpublic service|policy|government|international affairs|foreign service|leadership\b/.test(text)) disciplines.push("Public service");
  if (/\bhumanities|arts|literature|history|language|social science\b/.test(text)) disciplines.push("Humanities / social sciences");
  if (/\bhealth|medicine|medical|nursing|clinical\b/.test(text)) disciplines.push("Health");
  return disciplines;
}

function inferCitizenship(values: string[]) {
  const text = values.join(" ").toLowerCase();
  const citizenship: string[] = [];
  if (/\bu\.?s\.?\s+(citizen|national)|united states citizen/.test(text)) citizenship.push("U.S. citizens");
  if (/\bpermanent resident|green card/.test(text)) citizenship.push("Permanent residents");
  if (/\binternational students?|non-u\.?s\.?|foreign nationals?/.test(text)) citizenship.push("International applicants");
  return citizenship;
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
