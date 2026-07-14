import type { Json } from "@/lib/database.types";

export const monitoringFeedbackReasonCodes = [
  "capture_noise",
  "content_churn",
  "duplicate_update",
  "out_of_scope",
  "not_applicant_facing",
  "other",
] as const;

export type MonitoringFeedbackReasonCode =
  (typeof monitoringFeedbackReasonCodes)[number];

export const monitoringFeedbackScopes = [
  "event",
  "source",
  "award",
  "global",
] as const;

export type MonitoringFeedbackScope = (typeof monitoringFeedbackScopes)[number];

export const monitoringFeedbackReasonLabels: Record<
  MonitoringFeedbackReasonCode,
  string
> = {
  capture_noise: "Capture or rendering noise",
  content_churn: "Routine content churn",
  duplicate_update: "Duplicate update",
  out_of_scope: "Out-of-scope page content",
  not_applicant_facing: "Not applicant-facing",
  other: "Other",
};

export const monitoringFeedbackScopeLabels: Record<MonitoringFeedbackScope, string> = {
  event: "This event only",
  source: "Review for this source",
  award: "Review for this award",
  global: "Review as a global pattern",
};

export function monitoringFeedbackRequiresNote(
  reasonCode: MonitoringFeedbackReasonCode,
  requestedScope: MonitoringFeedbackScope,
) {
  return reasonCode === "other" || requestedScope !== "event";
}

export function monitoringFeedbackLabel(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function monitoringFeedbackEvidenceSummary(value: Json) {
  const evidence = jsonObject(value);
  if (!evidence) return null;

  const structuredDiff = jsonObject(evidence.structured_diff);
  const before = jsonText(evidence.exact_before) || jsonText(evidence.before);
  const after = jsonText(evidence.exact_after) || jsonText(evidence.after);
  const section = jsonText(evidence.section);
  const change = firstJsonText([
    ...(jsonArray(structuredDiff?.date_changes) || []),
    ...(jsonArray(structuredDiff?.amount_changes) || []),
  ]);
  const summary = jsonText(evidence.reader_summary);
  const parts = [
    section ? `Section: ${compactEvidenceText(section, 100)}` : null,
    before ? `Before: ${compactEvidenceText(before, 240)}` : null,
    after ? `After: ${compactEvidenceText(after, 240)}` : null,
    !before && !after && change
      ? `Changed fact: ${compactEvidenceText(change, 240)}`
      : null,
    !before && !after && !change && summary
      ? `Assessment: ${compactEvidenceText(summary, 320)}`
      : null,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" · ") : null;
}

function jsonObject(value: Json | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function jsonArray(value: Json | undefined) {
  return Array.isArray(value) ? value : null;
}

function jsonText(value: Json | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstJsonText(values: Json[]) {
  for (const value of values) {
    const text = jsonText(value);
    if (text) return text;
  }
  return null;
}

function compactEvidenceText(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}
