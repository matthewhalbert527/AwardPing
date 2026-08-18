import "server-only";

import type { Database } from "@/lib/database.types";
import type { OperatorRegressionAuditFailureInput } from "@/lib/operator-action-inbox";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type RegressionAuditStateRow = Database["public"]["Tables"]["shared_award_regression_audit_state"]["Row"];

const DEFAULT_STATE_PAGE_SIZE = 500;
const DEFAULT_AWARD_CHUNK_SIZE = 100;

type AdminRegressionAuditLoadOptions = {
  statePageSize?: number;
  awardChunkSize?: number;
};

export async function loadAdminRegressionAuditFailures(
  admin: AdminClient,
  options: AdminRegressionAuditLoadOptions = {},
): Promise<{ failures: OperatorRegressionAuditFailureInput[]; loadErrors: string[] }> {
  const statePageSize = boundedSize(options.statePageSize, DEFAULT_STATE_PAGE_SIZE, 1_000);
  const awardChunkSize = boundedSize(options.awardChunkSize, DEFAULT_AWARD_CHUNK_SIZE, 100);
  const stateResult = await loadAllRegressionAuditFailureRows(admin, statePageSize);
  if (stateResult.error) {
    return {
      failures: [],
      loadErrors: [`Regression audit retry state: ${stateResult.error}`],
    };
  }

  const rows = stateResult.rows;
  if (rows.length === 0) return { failures: [], loadErrors: [] };

  const awardIds = [...new Set(rows.map((row) => row.shared_award_id))];
  const awardResult = await loadAwardIdentities(admin, awardIds, awardChunkSize);
  if (awardResult.error) {
    return {
      failures: [],
      loadErrors: [`Regression audit award identities: ${awardResult.error}`],
    };
  }

  const awardById = new Map(awardResult.awards.map((award) => [award.id, award]));
  const missingAwardIds = awardIds.filter((awardId) => !awardById.has(awardId));
  if (missingAwardIds.length > 0) {
    return {
      failures: [],
      loadErrors: [
        `Regression audit award identities: ${missingAwardIds.length} retry state ${missingAwardIds.length === 1 ? "row references an award" : "rows reference awards"} that could not be loaded (${missingAwardIds.join(", ")}).`,
      ],
    };
  }

  return {
    failures: rows.map((row) => {
      const award = awardById.get(row.shared_award_id)!;
      return {
        failureKind: regressionFailureKind(row),
        awardId: row.shared_award_id,
        awardName: award.name,
        awardSlug: award.slug,
        officialHomepage: award.official_homepage,
        lastAttemptedAt: row.last_attempted_at,
        lastSucceededAt: row.last_succeeded_at,
        consecutiveFailures: row.consecutive_failures,
        nextRetryAt: row.next_retry_at,
        operationalError: row.last_operational_error,
        lastAuditError: row.last_audit_error,
        lastAuditId: row.last_audit_id,
        lastObservationKey: row.last_observation_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }),
    loadErrors: [],
  };
}

async function loadAllRegressionAuditFailureRows(
  admin: AdminClient,
  pageSize: number,
): Promise<{ rows: RegressionAuditStateRow[]; error: string | null }> {
  const initialRevision = await loadRegressionAuditRevision(admin);
  if (initialRevision.error) return { rows: [], error: initialRevision.error };

  const rows: RegressionAuditStateRow[] = [];
  const expectedCount = initialRevision.count;
  for (let start = 0; start < expectedCount; start += pageSize) {
    const pageResult = await admin
      .from("shared_award_regression_audit_state")
      .select("shared_award_id, last_attempted_at, last_succeeded_at, consecutive_failures, next_retry_at, last_operational_error, last_audit_error, last_audit_id, last_observation_key, created_at, updated_at", { count: "exact" })
      .or("last_operational_error.not.is.null,last_audit_error.not.is.null")
      .order("last_attempted_at", { ascending: true, nullsFirst: true })
      .order("shared_award_id", { ascending: true })
      .range(start, Math.min(expectedCount, start + pageSize) - 1);
    if (pageResult.error) return { rows: [], error: pageResult.error.message };

    const pageCount = exactCount(pageResult.count);
    if (pageCount === null) {
      return { rows: [], error: "Exact unresolved-row count was unavailable during pagination." };
    }
    if (pageCount !== expectedCount) {
      return { rows: [], error: "Regression audit retry rows changed during paginated loading." };
    }
    const page = (pageResult.data || []) as RegressionAuditStateRow[];
    const expectedPageLength = Math.min(pageSize, expectedCount - start);
    if (page.length !== expectedPageLength) {
      return { rows: [], error: "Regression audit pagination returned an incomplete page." };
    }
    rows.push(...page);
  }

  const finalRevision = await loadRegressionAuditRevision(admin);
  if (finalRevision.error) return { rows: [], error: finalRevision.error };
  if (
    finalRevision.count !== expectedCount ||
    finalRevision.revision !== initialRevision.revision
  ) {
    return { rows: [], error: "Regression audit retry rows changed during paginated loading." };
  }

  const uniqueRows = [...new Map(rows.map((row) => [row.shared_award_id, row])).values()];
  if (rows.length !== expectedCount || uniqueRows.length !== expectedCount) {
    return {
      rows: [],
      error: "Regression audit pagination did not return every unresolved award exactly once.",
    };
  }
  return { rows: uniqueRows, error: null };
}

async function loadRegressionAuditRevision(
  admin: AdminClient,
): Promise<{ count: number; revision: string | null; error: string | null }> {
  const result = await admin
    .from("shared_award_regression_audit_state")
    .select("shared_award_id, updated_at", { count: "exact" })
    .or("last_operational_error.not.is.null,last_audit_error.not.is.null")
    .order("updated_at", { ascending: false })
    .order("shared_award_id", { ascending: true })
    .range(0, 0);
  if (result.error) return { count: 0, revision: null, error: result.error.message };

  const count = exactCount(result.count);
  if (count === null) {
    return { count: 0, revision: null, error: "Exact unresolved-row count was unavailable." };
  }
  const row = (result.data || [])[0];
  if (count > 0 && !row) {
    return { count, revision: null, error: "Retry-state revision was unavailable for a non-empty result." };
  }
  return {
    count,
    revision: row ? `${row.updated_at}:${row.shared_award_id}` : null,
    error: null,
  };
}

async function loadAwardIdentities(
  admin: AdminClient,
  awardIds: string[],
  chunkSize: number,
) {
  const awards: Array<{
    id: string;
    name: string;
    slug: string | null;
    official_homepage: string | null;
  }> = [];
  for (const idChunk of chunks(awardIds, chunkSize)) {
    const result = await admin
      .from("shared_awards")
      .select("id, name, slug, official_homepage", { count: "exact" })
      .in("id", idChunk)
      .order("id", { ascending: true })
      .range(0, idChunk.length - 1);
    if (result.error) return { awards: [], error: result.error.message };
    const count = exactCount(result.count);
    if (count === null || count !== idChunk.length) {
      return { awards: [], error: "One or more corresponding award identities could not be loaded." };
    }
    awards.push(...(result.data || []));
  }
  const uniqueAwards = [...new Map(awards.map((award) => [award.id, award])).values()];
  if (awards.length !== awardIds.length || uniqueAwards.length !== awardIds.length) {
    return { awards: [], error: "Award identity pagination returned duplicates or an incomplete result." };
  }
  return { awards: uniqueAwards, error: null as string | null };
}

function exactCount(value: number | null) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function boundedSize(value: number | undefined, fallback: number, maximum: number) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(maximum, parsed) : fallback;
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function regressionFailureKind(
  row: RegressionAuditStateRow,
): OperatorRegressionAuditFailureInput["failureKind"] {
  const operational = row.last_operational_error !== null;
  const blockingAudit = row.last_audit_error !== null;
  if (operational && blockingAudit) return "operational_and_blocking";
  if (blockingAudit) return "blocking_audit";
  return "operational";
}
