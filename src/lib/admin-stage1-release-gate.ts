import "server-only";

import type { Database } from "@/lib/database.types";
import { checkInviteOnlySignupReleaseReadiness } from "@/lib/invite-only-signup-readiness";
import {
  stage1ReleaseArtifactKinds,
  type Stage1EffectivePublication,
  type Stage1MigrationIdentity,
  type Stage1ReleaseArtifact,
  type Stage1ReleaseArtifactKind,
  type Stage1ReleaseGateInput,
} from "@/lib/stage1-release-gate-summary";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  stage1CohortIdentityHash,
  stage1CohortIdentityMismatch,
  stage1CohortIdentityVersion,
  type Stage1CohortIdentityRow,
} from "@/lib/stage1-cohort-identity";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type RegistryRow = Database["public"]["Tables"]["stage1_award_registry"]["Row"];
type ManifestRow = Database["public"]["Tables"]["stage1_award_source_manifest"]["Row"];
type MemberRow = Database["public"]["Tables"]["stage1_award_members"]["Row"];
type ReconciliationRow = Database["public"]["Tables"]["shared_award_reconciliation_queue"]["Row"];
type AuditRow = Database["public"]["Tables"]["shared_award_page_audits"]["Row"];

export type AdminStage1ReleaseGateEvidence = Pick<
  Stage1ReleaseGateInput,
  | "registry"
  | "manifests"
  | "effectivePublication"
  | "latestReconciliations"
  | "latestAudits"
  | "quarantineCountsByCohort"
  | "inviteReadiness"
  | "inviteSecurityReissues"
  | "migrationIdentity"
  | "releaseArtifacts"
  | "loadErrors"
>;

export async function loadAdminStage1ReleaseGateEvidence(
  admin: AdminClient,
): Promise<AdminStage1ReleaseGateEvidence> {
  const [
    registryResult,
    membersResult,
    manifestsResult,
    effectiveResult,
    snapshotResult,
    inviteReadiness,
    contractResult,
    inviteReissueStatusResult,
    releaseArtifactsResult,
  ] =
    await Promise.all([
      admin.from("stage1_award_registry").select("*").order("launch_rank", { ascending: true }),
      admin.from("stage1_award_members").select("*").order("cohort_key", { ascending: true }),
      admin.from("stage1_award_source_manifest").select("*").order("cohort_key", { ascending: true }),
      admin.rpc("list_stage1_effective_publication"),
      admin.rpc("get_stage1_publication_snapshot"),
      checkInviteOnlySignupReleaseReadiness(),
      admin.rpc("get_awardping_release_contract_status"),
      admin.rpc("get_office_invite_security_reissue_status"),
      admin
        .from("stage1_release_acceptance_artifacts")
        .select("*")
        .in("artifact_kind", [...stage1ReleaseArtifactKinds])
        .order("completed_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(40),
    ]);

  const registry = (registryResult.data || []) as RegistryRow[];
  const members = (membersResult.data || []) as MemberRow[];
  const manifests = (manifestsResult.data || []) as ManifestRow[];
  const effectivePublication = (effectiveResult.data || []) as Stage1EffectivePublication[];
  const inviteSecurityReissues = parseInviteSecurityReissueStatus(
    inviteReissueStatusResult.data,
  );
  const loadErrors = errorMessages([
    ["Stage 1 registry", registryResult.error?.message],
    ["Stage 1 cohort members", membersResult.error?.message],
    ["Stage 1 source manifests", manifestsResult.error?.message],
    ["Stage 1 effective publication", effectiveResult.error?.message],
    ["Stage 1 publication snapshot", snapshotResult.error?.message],
    ["Invite/free-check migration contract", contractResult.error?.message],
    ["Invite security reissue aggregate", inviteReissueStatusResult.error?.message],
    ["Invite security reissue evidence", inviteSecurityReissues.error || undefined],
    ["Stage 1 release acceptance artifacts", releaseArtifactsResult.error?.message],
  ]);
  const releaseArtifacts = latestReleaseArtifacts(
    (releaseArtifactsResult.data || []) as Stage1ReleaseArtifact[],
  );

  const [latestEvidence, quarantineEvidence] = await Promise.all([
    loadLatestCanonicalEvidence(admin, registry),
    loadActionableQuarantineCounts(admin, members),
  ]);
  loadErrors.push(...latestEvidence.loadErrors, ...quarantineEvidence.loadErrors);

  return {
    registry,
    manifests,
    effectivePublication,
    latestReconciliations: latestEvidence.latestReconciliations,
    latestAudits: latestEvidence.latestAudits,
    quarantineCountsByCohort: quarantineEvidence.countsByCohort,
    inviteReadiness,
    inviteSecurityReissues: inviteReissueStatusResult.error
      ? { count: null, oldestAt: null }
      : inviteSecurityReissues.evidence,
    migrationIdentity: migrationIdentity({
      effectiveError: effectiveResult.error?.message,
      snapshotError: snapshotResult.error?.message,
      contractError: contractResult.error?.message,
      snapshot: snapshotResult.data,
      contract: contractResult.data,
    }),
    releaseArtifacts,
    loadErrors: [...new Set(loadErrors)],
  };
}

function latestReleaseArtifacts(rows: Stage1ReleaseArtifact[]) {
  const latest: Partial<Record<Stage1ReleaseArtifactKind, Stage1ReleaseArtifact>> = {};
  for (const row of rows) {
    if (!stage1ReleaseArtifactKinds.includes(row.artifact_kind)) continue;
    if (!latest[row.artifact_kind]) latest[row.artifact_kind] = row;
  }
  return latest;
}

async function loadLatestCanonicalEvidence(admin: AdminClient, registry: RegistryRow[]) {
  const evidence = await Promise.all(
    registry.map(async (award) => {
      const [reconciliationResult, auditResult] = await Promise.all([
        admin
          .from("shared_award_reconciliation_queue")
          .select("*")
          .eq("shared_award_id", award.canonical_shared_award_id)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle(),
        admin
          .from("shared_award_page_audits")
          .select("*")
          .eq("shared_award_id", award.canonical_shared_award_id)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      return { award, reconciliationResult, auditResult };
    }),
  );
  const latestReconciliations: Record<string, ReconciliationRow | null> = {};
  const latestAudits: Record<string, AuditRow | null> = {};
  const loadErrors: string[] = [];
  for (const entry of evidence) {
    const awardId = entry.award.canonical_shared_award_id;
    latestReconciliations[awardId] = (entry.reconciliationResult.data || null) as ReconciliationRow | null;
    latestAudits[awardId] = (entry.auditResult.data || null) as AuditRow | null;
    if (entry.reconciliationResult.error) {
      loadErrors.push(`${entry.award.canonical_name} reconciliation: ${entry.reconciliationResult.error.message}`);
    }
    if (entry.auditResult.error) {
      loadErrors.push(`${entry.award.canonical_name} page audit: ${entry.auditResult.error.message}`);
    }
  }
  return { latestReconciliations, latestAudits, loadErrors };
}

async function loadActionableQuarantineCounts(admin: AdminClient, members: MemberRow[]) {
  const memberIds = [...new Set(members.map((member) => member.shared_award_id))];
  const cohortByAwardId = new Map(members.map((member) => [member.shared_award_id, member.cohort_key]));
  const countsByCohort: Record<string, number> = {};
  for (const member of members) countsByCohort[member.cohort_key] = 0;
  if (memberIds.length === 0) return { countsByCohort, loadErrors: [] as string[] };

  const sourceResult = await admin
    .from("shared_award_sources")
    .select("id,shared_award_id")
    .in("shared_award_id", memberIds);
  if (sourceResult.error) {
    return {
      countsByCohort: {},
      loadErrors: [`Stage 1 quarantine source identities: ${sourceResult.error.message}`],
    };
  }
  const cohortBySourceId = new Map(
    (sourceResult.data || []).map((source) => [
      source.id,
      cohortByAwardId.get(source.shared_award_id),
    ]),
  );
  const sourceIds = [...cohortBySourceId.keys()];
  const awardRows = await loadQuarantineRows(admin, "shared_award_id", memberIds);
  const sourceRows = await loadQuarantineRows(
    admin,
    "shared_award_source_id",
    sourceIds,
  );
  if (awardRows.error || sourceRows.error) {
    return {
      countsByCohort: {},
      loadErrors: [awardRows.error || sourceRows.error || "Stage 1 quarantine load failed."],
    };
  }
  const rows = [...awardRows.rows, ...sourceRows.rows];
  const uniqueRows = [...new Map(rows.map((row) => [row.id, row])).values()];
  for (const row of uniqueRows) {
    const cohortKey = row.shared_award_id
      ? cohortByAwardId.get(row.shared_award_id)
      : row.shared_award_source_id
        ? cohortBySourceId.get(row.shared_award_source_id)
        : null;
    if (cohortKey) countsByCohort[cohortKey] = (countsByCohort[cohortKey] || 0) + 1;
  }
  return { countsByCohort, loadErrors: [] as string[] };
}

type QuarantineCountRow = {
  id: string;
  shared_award_id: string | null;
  shared_award_source_id: string | null;
};

async function loadQuarantineRows(
  admin: AdminClient,
  column: "shared_award_id" | "shared_award_source_id",
  ids: string[],
) {
  const rows: QuarantineCountRow[] = [];
  for (const idChunk of chunks(ids, 100)) {
    let expectedCount: number | null = null;
    for (let start = 0; ; start += 200) {
      const result = await admin
        .from("manual_quarantine_registry")
        .select("id,shared_award_id,shared_award_source_id", { count: "exact" })
        .in(column, idChunk)
        .eq("classification", "actionable_quarantine")
        .in("status", ["quarantined", "in_review"])
        .order("id", { ascending: true })
        .range(start, start + 199);
      if (result.error) {
        return { rows: [], error: `Stage 1 quarantine registry: ${result.error.message}` };
      }
      const page = (result.data || []) as QuarantineCountRow[];
      const pageCount = Number(result.count || 0);
      if (expectedCount === null) expectedCount = pageCount;
      if (pageCount !== expectedCount) {
        return {
          rows: [],
          error: "Stage 1 quarantine registry changed while exact counts were loading.",
        };
      }
      rows.push(...page);
      if (start + page.length >= expectedCount || page.length < 200) break;
    }
  }
  return { rows, error: null as string | null };
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function parseInviteSecurityReissueStatus(value: unknown): {
  evidence: Stage1ReleaseGateInput["inviteSecurityReissues"];
  error: string | null;
} {
  if (!isRecord(value)) {
    return {
      evidence: { count: null, oldestAt: null },
      error: "The aggregate RPC returned no structured evidence.",
    };
  }
  const count = value.unresolved_count;
  const oldestAt = value.oldest_rotated_at;
  const evaluatedAt = value.evaluated_at;
  const countValid = typeof count === "number" && Number.isInteger(count) && count >= 0;
  const oldestValid = count === 0
    ? oldestAt === null
    : typeof oldestAt === "string" && Number.isFinite(Date.parse(oldestAt));
  if (
    !countValid ||
    !oldestValid ||
    typeof evaluatedAt !== "string" ||
    !Number.isFinite(Date.parse(evaluatedAt))
  ) {
    return {
      evidence: { count: null, oldestAt: null },
      error: "The aggregate RPC returned malformed exact-count or oldest-age evidence.",
    };
  }
  return {
    evidence: {
      count,
      oldestAt: oldestAt as string | null,
    },
    error: null,
  };
}

function migrationIdentity({
  effectiveError,
  snapshotError,
  contractError,
  snapshot,
  contract,
}: {
  effectiveError?: string;
  snapshotError?: string;
  contractError?: string;
  snapshot: unknown;
  contract: unknown;
}): Stage1MigrationIdentity {
  if (effectiveError || snapshotError || contractError) {
    return {
      status: "unknown",
      reason: "Required Stage 1, invite-only, or free-check migration contracts could not be verified.",
    };
  }
  if (
    !isRecord(contract) ||
    contract.contract_version !== "awardping-release-contract-v1" ||
    contract.matches !== true ||
    contract.requirement_count !== 16 ||
    !Array.isArray(contract.missing) ||
    contract.missing.length !== 0
  ) {
    return {
      status: "mismatch",
      reason: "The versioned invite-only and atomic free-check database contract is missing or mismatched.",
    };
  }
  if (snapshot === null || snapshot === undefined) {
    return {
      status: "mismatch",
      reason: "The Stage 1 publication snapshot contract returned no evidence.",
    };
  }
  if (
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    !("schema_version" in snapshot) ||
    snapshot.schema_version !== 3 ||
    !("cohort_identity_version" in snapshot) ||
    snapshot.cohort_identity_version !== stage1CohortIdentityVersion ||
    !("cohort_identity_hash" in snapshot) ||
    snapshot.cohort_identity_hash !== stage1CohortIdentityHash ||
    !("cohorts" in snapshot) ||
    !Array.isArray(snapshot.cohorts) ||
    snapshot.cohorts.length !== 25 ||
    !("release" in snapshot) ||
    !isRecord(snapshot.release)
  ) {
    return {
      status: "mismatch",
    reason: "The Stage 1 publication snapshot identity does not match the reviewed national 25 cohort.",
    };
  }
  const snapshotRegistry = snapshot.cohorts.map((cohort) =>
    cohort && typeof cohort === "object" && !Array.isArray(cohort) && "registry" in cohort
      ? cohort.registry
      : null,
  );
  if (
    snapshotRegistry.some((row) => !row || typeof row !== "object" || Array.isArray(row)) ||
    stage1CohortIdentityMismatch(snapshotRegistry as Stage1CohortIdentityRow[])
  ) {
    return {
      status: "mismatch",
      reason: "The Stage 1 registry rows do not exactly match the reviewed national 25 cohort.",
    };
  }
  const release = snapshot.release;
  if (
    release.release_key !== "stage1-national-25" ||
    release.policy_version !== "stage1-publication-v1" ||
    release.cohort_identity_version !== stage1CohortIdentityVersion ||
    release.cohort_identity_hash !== stage1CohortIdentityHash
  ) {
    return {
      status: "mismatch",
      reason: "The authoritative Stage 1 release identity does not match the reviewed national 25 cohort.",
    };
  }
  const releaseState = release.release_state;
  const releaseEpoch = release.release_epoch;
  const effectiveValues = snapshot.cohorts.map((cohort) =>
    isRecord(cohort) ? cohort.effectively_verified : null,
  );
  const effectiveCount = effectiveValues.filter((value) => value === true).length;
  const registryEpochs = snapshot.cohorts.map((cohort) => {
    if (!isRecord(cohort) || !isRecord(cohort.registry)) return undefined;
    return cohort.registry.release_epoch;
  });
  const activeReleaseValid = releaseState === "verified_beta" &&
    typeof releaseEpoch === "string" &&
    effectiveValues.every((value) => typeof value === "boolean") &&
    (effectiveCount === 0 || effectiveCount === 25) &&
    release.effectively_released === (effectiveCount === 25) &&
    registryEpochs.every((value) => value === releaseEpoch);
  const closedReleaseValid = releaseState !== "verified_beta" &&
    releaseEpoch === null &&
    effectiveValues.every((value) => value === false) &&
    registryEpochs.every((value) => value === null);
  if (!activeReleaseValid && !closedReleaseValid) {
    return {
      status: "mismatch",
      reason: "The Stage 1 snapshot is partial or mixes release epochs; public release must remain closed.",
    };
  }
  return {
    status: "match",
    reason: "Stage 1 publication, invite-only, and atomic free-check contracts match the reviewed release versions.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessages(entries: Array<[string, string | undefined]>) {
  return entries
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, message]) => `${label}: ${message}`);
}
