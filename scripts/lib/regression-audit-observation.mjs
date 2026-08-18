import { createHash } from "node:crypto";

export const REGRESSION_EVALUATION_CONTRACT = "stage1-regression-evaluation-v1";

const regressionAwardFields = Object.freeze([
  "id",
  "name",
  "slug",
  "official_homepage",
  "summary",
  "public_facts",
  "confidence",
  "status",
]);

const regressionSourceFields = Object.freeze([
  "id",
  "shared_award_id",
  "url",
  "title",
  "display_title",
  "page_description",
  "page_metadata",
  "page_metadata_generated_at",
  "page_metadata_model",
  "page_type",
  "source",
  "reason",
  "submitted_by_user_id",
  "admin_review_status",
  "confidence",
]);

export const REGRESSION_AUDIT_RUN_ONLY_PATHS = Object.freeze([
  "public_page_snapshot.evaluated_at",
  "*.reconciliation.generated_at",
  "*.observation_key",
]);

export function stableRegressionAuditValue(value, parentKey = null) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableRegressionAuditValue(entry, parentKey));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, nested]) => (
        nested !== undefined
        && key !== "observation_key"
        && !(parentKey === "public_page_snapshot" && key === "evaluated_at")
        && !(parentKey === "reconciliation" && key === "generated_at")
      ))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableRegressionAuditValue(nested, key)]),
  );
}

export function regressionAuditObservationBasis(auditRow) {
  return stableRegressionAuditValue({
    audit_kind: auditRow?.audit_kind ?? null,
    audit_status: auditRow?.audit_status ?? null,
    severity: auditRow?.severity ?? null,
    findings: auditRow?.findings ?? null,
    suggested_fixes: auditRow?.suggested_fixes ?? null,
    field_conflicts: auditRow?.field_conflicts ?? null,
    source_rejections: auditRow?.source_rejections ?? null,
    selected_fact_summary: auditRow?.selected_fact_summary ?? null,
    public_page_snapshot: auditRow?.public_page_snapshot ?? null,
    model: auditRow?.model ?? null,
  });
}

export function regressionAuditObservationKey(auditRow) {
  return createHash("sha256")
    .update(JSON.stringify(regressionAuditObservationBasis(auditRow)), "utf8")
    .digest("hex");
}

export function regressionEvaluationBasis(award, sources) {
  return canonicalJsonValue({
    contract_version: REGRESSION_EVALUATION_CONTRACT,
    award: selectFields(award, regressionAwardFields),
    sources: [...(Array.isArray(sources) ? sources : [])]
      .map((source) => selectFields(source, regressionSourceFields))
      .sort(compareRegressionSources),
  });
}

export function regressionEvaluationRevision(award, sources) {
  return createHash("sha256")
    .update(JSON.stringify(regressionEvaluationBasis(award, sources)), "utf8")
    .digest("hex");
}

export function requireRegressionEvaluation(awardRow) {
  const evaluation = awardRow?.regression_evaluation;
  if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
    throw new Error("Regression selector returned no immutable evaluation envelope.");
  }
  if (evaluation.contract_version !== REGRESSION_EVALUATION_CONTRACT) {
    throw new Error("Regression selector returned an unsupported evaluation contract.");
  }
  if (!/^[0-9a-f]{64}$/.test(String(evaluation.revision || ""))) {
    throw new Error("Regression selector returned no valid evaluation revision.");
  }
  if (!Number.isFinite(Date.parse(String(evaluation.selected_at || "")))) {
    throw new Error("Regression selector returned no valid evaluation selection time.");
  }
  if (!evaluation.award || typeof evaluation.award !== "object" || Array.isArray(evaluation.award)) {
    throw new Error("Regression selector returned no award input snapshot.");
  }
  if (!Array.isArray(evaluation.sources)) {
    throw new Error("Regression selector returned no complete source input array.");
  }
  if (!Number.isInteger(evaluation.source_count)
    || evaluation.source_count !== evaluation.sources.length) {
    throw new Error("Regression selector source count does not match its source snapshot.");
  }
  if (evaluation.award.id !== awardRow?.id) {
    throw new Error("Regression selector award identity does not match its evaluation snapshot.");
  }

  const topLevelAward = selectFields(awardRow, regressionAwardFields);
  const snapshottedAward = selectFields(evaluation.award, regressionAwardFields);
  if (JSON.stringify(canonicalJsonValue(topLevelAward))
    !== JSON.stringify(canonicalJsonValue(snapshottedAward))) {
    throw new Error("Regression selector award fields do not match its evaluation snapshot.");
  }

  const sourceIds = new Set();
  for (const source of evaluation.sources) {
    if (!source?.id || source.shared_award_id !== awardRow.id) {
      throw new Error("Regression selector returned a source outside the selected award.");
    }
    if (sourceIds.has(source.id)) {
      throw new Error("Regression selector returned a duplicate source input.");
    }
    sourceIds.add(source.id);
  }
  const orderedSources = [...evaluation.sources].sort(compareRegressionSources);
  if (orderedSources.some((source, index) => source.id !== evaluation.sources[index]?.id)) {
    throw new Error("Regression selector source inputs are not deterministically ordered.");
  }

  // The database revision protects persistence from external mutations. Keep
  // the in-process copy immutable as well so evaluation helpers cannot
  // accidentally drift away from the revision they will submit.
  deepFreeze(awardRow);

  return {
    contractVersion: evaluation.contract_version,
    revision: evaluation.revision,
    selectedAt: String(evaluation.selected_at),
    sourceCount: evaluation.source_count,
    sources: evaluation.sources,
  };
}

export function canAcceptedRegressionPassResolve({
  passEvaluatedAt,
  blockingEvaluatedAt,
}) {
  const passTime = comparableTimestamp(passEvaluatedAt);
  const blockingTime = comparableTimestamp(blockingEvaluatedAt);
  return Boolean(passTime && blockingTime && blockingTime < passTime);
}

export function shouldRegressionStateAdvance({
  candidateEvaluatedAt,
  currentEvaluatedAt,
  candidateBlocks = false,
  currentBlocks = false,
}) {
  const candidateTime = comparableTimestamp(candidateEvaluatedAt);
  const currentTime = comparableTimestamp(currentEvaluatedAt);
  if (!candidateTime) return false;
  if (!currentTime) return true;
  if (candidateBlocks && !currentBlocks) return true;
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return false;
}

export function nextRegressionAuditRetryAt(attemptedAt, consecutiveFailures) {
  const attemptedMs = new Date(attemptedAt).getTime();
  const failures = Math.max(1, Math.floor(Number(consecutiveFailures) || 1));
  const delaySeconds = Math.min(21_600, 300 * (2 ** Math.min(failures - 1, 7)));
  return new Date(attemptedMs + delaySeconds * 1_000).toISOString();
}

export function orderRegressionAuditCandidates(rows, now = new Date().toISOString()) {
  const nowMs = new Date(now).getTime();
  return [...rows]
    .filter((row) => !row.next_retry_at || new Date(row.next_retry_at).getTime() <= nowMs)
    .sort((left, right) => {
      const leftAttempt = left.last_attempted_at ? new Date(left.last_attempted_at).getTime() : Number.NEGATIVE_INFINITY;
      const rightAttempt = right.last_attempted_at ? new Date(right.last_attempted_at).getTime() : Number.NEGATIVE_INFINITY;
      return leftAttempt - rightAttempt
        || new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
        || String(left.id).localeCompare(String(right.id));
    });
}

function selectFields(value, fields) {
  return Object.fromEntries(fields.map((field) => [field, value?.[field] ?? null]));
}

function compareRegressionSources(left, right) {
  const leftTime = sourceTimestampKey(left?.page_metadata_generated_at);
  const rightTime = sourceTimestampKey(right?.page_metadata_generated_at);
  if (leftTime !== rightTime) return rightTime.localeCompare(leftTime);
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function sourceTimestampKey(value) {
  return comparableTimestamp(value);
}

function comparableTimestamp(value) {
  const clean = String(value || "");
  const utc = clean.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/);
  if (utc) return `${utc[1]}.${String(utc[2] || "").padEnd(6, "0")}Z`;
  return Number.isFinite(Date.parse(clean)) ? new Date(clean).toISOString() : "";
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
