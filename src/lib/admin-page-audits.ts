import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type AdminClient = SupabaseClient<Database>;
type Json = Database["public"]["Tables"]["shared_award_page_audits"]["Row"]["findings"];

const auditStatuses = ["passed", "warnings", "failed", "needs_review"] as const;
const auditSeverities = ["info", "warning", "error", "critical"] as const;

export type PageAuditStatus = (typeof auditStatuses)[number];
export type PageAuditSeverity = (typeof auditSeverities)[number];

export type PageAuditExample = {
  id: string;
  awardId: string;
  awardName: string;
  awardSlug: string | null;
  status: string;
  severity: string;
  finding: string;
  currentValue: string | null;
  suggestedValue: string | null;
  createdAt: string;
};

export type PageAuditSummary = {
  configured: boolean;
  warning: string | null;
  statusCounts: Record<PageAuditStatus, number>;
  severityCounts: Record<PageAuditSeverity, number>;
  unresolved: number;
  critical: number;
  commonFindings: Array<{ reason: string; count: number }>;
  latestExamples: PageAuditExample[];
  latestBatch: {
    name: string | null;
    model: string | null;
    requestCount: number;
    latestCreatedAt: string | null;
  };
};

type AuditRow = {
  id: string;
  shared_award_id: string;
  audit_status: string;
  severity: string;
  findings: Json;
  suggested_fixes: Json;
  field_conflicts: Json;
  selected_fact_summary: Json;
  public_page_snapshot: Json;
  model: string | null;
  gemini_batch_name: string | null;
  created_at: string;
  resolved_at: string | null;
  shared_awards?: { name?: string | null; slug?: string | null } | Array<{ name?: string | null; slug?: string | null }> | null;
};

export async function loadPageAuditSummary(
  admin: AdminClient,
): Promise<{ summary: PageAuditSummary; warnings: string[]; loadErrors: string[] }> {
  const rawAdmin = admin as unknown as SupabaseClient;
  const warnings: string[] = [];
  const loadErrors: string[] = [];
  const { data, error } = await rawAdmin
    .from("shared_award_page_audits")
    .select(
      "id,shared_award_id,audit_status,severity,findings,suggested_fixes,field_conflicts,selected_fact_summary,public_page_snapshot,model,gemini_batch_name,created_at,resolved_at,shared_awards(name,slug)",
    )
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error?.message) {
    if (isMissingRelationError(error.message)) {
      const warning = "Page audit table is not configured yet.";
      warnings.push(warning);
      return { summary: summarizePageAudits([], warning), warnings, loadErrors };
    }
    loadErrors.push(error.message);
  }
  return {
    summary: summarizePageAudits((data || []) as unknown as AuditRow[]),
    warnings,
    loadErrors,
  };
}

export function summarizePageAudits(rows: Array<Record<string, unknown>>, warning: string | null = null): PageAuditSummary {
  if (warning) {
    return {
      configured: false,
      warning,
      statusCounts: emptyStatusCounts(),
      severityCounts: emptySeverityCounts(),
      unresolved: 0,
      critical: 0,
      commonFindings: [],
      latestExamples: [],
      latestBatch: { name: null, model: null, requestCount: 0, latestCreatedAt: null },
    };
  }

  const statusCounts = emptyStatusCounts();
  const severityCounts = emptySeverityCounts();
  const findingCounts = new Map<string, number>();
  let unresolved = 0;
  let critical = 0;
  for (const row of rows) {
    const status = cleanAuditStatus(row.audit_status);
    const severity = cleanAuditSeverity(row.severity);
    if (status) statusCounts[status] += 1;
    if (severity) severityCounts[severity] += 1;
    if (!cleanText(row.resolved_at) && status && status !== "passed") unresolved += 1;
    if (!cleanText(row.resolved_at) && severity === "critical") critical += 1;
    for (const finding of findingCodes(row)) incrementMap(findingCounts, finding);
  }

  const latestBatchName = rows.map((row) => cleanText(row.gemini_batch_name)).find(Boolean) || null;
  const latestBatchRows = latestBatchName ? rows.filter((row) => cleanText(row.gemini_batch_name) === latestBatchName) : [];
  const latestBatchSource = latestBatchRows[0] || {};
  return {
    configured: true,
    warning: null,
    statusCounts,
    severityCounts,
    unresolved,
    critical,
    commonFindings: reasonCountsFromMap(findingCounts),
    latestExamples: rows
      .filter((row) => !cleanText(row.resolved_at) && cleanAuditStatus(row.audit_status) !== "passed")
      .slice(0, 8)
      .map(auditExample),
    latestBatch: {
      name: latestBatchName,
      model: cleanText(latestBatchSource.model) || null,
      requestCount: latestBatchRows.length,
      latestCreatedAt: cleanText(latestBatchSource.created_at) || null,
    },
  };
}

export function pageAuditFindingCategory(findingCode: string) {
  const code = cleanKey(findingCode);
  if (/sibling|identity-mismatch|description-mentions/.test(code)) return "sibling_source_contamination";
  if (/unsupported-description|missing-description/.test(code)) return "unsupported_description";
  if (/unsupported-deadline|deadline-missing-evidence/.test(code)) return "unsupported_deadline";
  if (/deadline.*conflict|field-conflict.*deadline/.test(code)) return "deadline_conflict";
  if (/invented.*future/.test(code)) return "invented_future_deadline";
  if (/stale.*cycle|cycle.*upcoming/.test(code)) return "stale_cycle_shown_upcoming";
  if (/missing-amount/.test(code)) return "missing_amount_with_official_evidence";
  if (/application.*material|vague/.test(code)) return "vague_application_materials";
  if (/generic.*listing/.test(code)) return "generic_listing_used_for_facts";
  return code || "page_audit_finding";
}

function auditExample(row: Record<string, unknown>): PageAuditExample {
  const award = embeddedAward(row.shared_awards);
  const finding = firstFinding(row);
  return {
    id: cleanText(row.id),
    awardId: cleanText(row.shared_award_id),
    awardName: award.name || "Unknown award",
    awardSlug: award.slug,
    status: cleanText(row.audit_status) || "unknown",
    severity: cleanText(row.severity) || "unknown",
    finding: cleanText(finding.message) || cleanText(finding.code) || "Page audit finding",
    currentValue: cleanText(finding.current_value || finding.currentValue || finding.current) || null,
    suggestedValue: cleanText(finding.suggested_value || finding.suggestedValue || finding.expected) || null,
    createdAt: cleanText(row.created_at),
  };
}

function firstFinding(row: Record<string, unknown>) {
  const findings = arrayValue(row.findings);
  if (findings.length > 0) return objectValue(findings[0]);
  const conflicts = arrayValue(row.field_conflicts);
  if (conflicts.length > 0) return objectValue(conflicts[0]);
  const fixes = arrayValue(row.suggested_fixes);
  if (fixes.length > 0) return objectValue(fixes[0]);
  return {};
}

function findingCodes(row: Record<string, unknown>) {
  const codes: string[] = [];
  for (const finding of arrayValue(row.findings)) {
    const object = objectValue(finding);
    codes.push(pageAuditFindingCategory(cleanText(object.code || object.reason || object.finding || object.field_name)));
  }
  for (const conflict of arrayValue(row.field_conflicts)) {
    const object = objectValue(conflict);
    const field = cleanText(object.field_name || object.field);
    codes.push(pageAuditFindingCategory(field ? `field_conflict_${field}` : "field_conflict"));
  }
  return codes.filter(Boolean);
}

function emptyStatusCounts() {
  return Object.fromEntries(auditStatuses.map((status) => [status, 0])) as Record<PageAuditStatus, number>;
}

function emptySeverityCounts() {
  return Object.fromEntries(auditSeverities.map((severity) => [severity, 0])) as Record<PageAuditSeverity, number>;
}

function cleanAuditStatus(value: unknown): PageAuditStatus | null {
  const status = cleanText(value);
  return auditStatuses.includes(status as PageAuditStatus) ? (status as PageAuditStatus) : null;
}

function cleanAuditSeverity(value: unknown): PageAuditSeverity | null {
  const severity = cleanText(value);
  return auditSeverities.includes(severity as PageAuditSeverity) ? (severity as PageAuditSeverity) : null;
}

function embeddedAward(value: unknown) {
  const object = Array.isArray(value) ? objectValue(value[0]) : objectValue(value);
  return {
    name: cleanText(object.name),
    slug: cleanText(object.slug) || null,
  };
}

function incrementMap(map: Map<string, number>, key: string) {
  map.set(key || "unknown", (map.get(key || "unknown") || 0) + 1);
}

function reasonCountsFromMap(map: Map<string, number>) {
  return [...map.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function isMissingRelationError(message: string) {
  return /schema cache|does not exist|could not find the table|could not find.*column|column .* does not exist|42P01|42703|PGRST/i.test(
    message,
  );
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanKey(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
