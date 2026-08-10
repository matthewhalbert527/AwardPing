import {
  buildVisualNightlyReport,
  type VisualNightlyReport,
  type WorkerRun,
} from "@/lib/admin-run-report";
import {
  downstreamLaneRuntimeState,
  type AdminDownstreamLane,
  type AdminEvidenceRecoveryStatus,
  type AdminGeminiBudgetLane,
} from "@/lib/admin-worker-operations";
import type { Database, Json } from "@/lib/database.types";
import type { InviteOnlySignupReadiness } from "@/lib/invite-only-signup-readiness";
import {
  stage1CohortIdentityHash,
  stage1CohortIdentityMismatch,
  stage1CohortIdentityVersion,
} from "@/lib/stage1-cohort-identity";
import { classifyScheduledNightlyVisualRun } from "../../scripts/lib/visual-nightly-run-contract.mjs";

export const stage1ReleaseAwardCount = 25;
export const stage1ReleaseManifestRoles = [
  "identity_home",
  "eligibility",
  "application_materials",
  "dates_cycle",
  "funding",
  "faq",
  "selection_interviews",
  "current_documents",
] as const;

const evidenceFreshnessMs = 24 * 60 * 60 * 1_000;
const futureClockToleranceMs = 5 * 60 * 1_000;
const authoritativeSnapshotFreshnessMs = 5 * 60 * 1_000;
const hostedRuntimeFreshnessMs = 60 * 60 * 1_000;
const hostedRuntimeMaximumValidityMs = 2 * 60 * 60 * 1_000;
const nightlyAcceptanceCohortCount = 3 as const;
const nightlyAcceptanceSoakMs = 24 * 60 * 60 * 1_000;
const expectedPolicyVersion = "stage1-publication-v1";
const canonicalReleaseEpochPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const expectedBudgetLanes = ["new_page_review", "changed_page_review"] as const;
const expectedDownstreamLanes = [
  ["new_page_review", "New page review", true],
  ["changed_page_review", "Changed page review", true],
  ["feedback_promotion", "Feedback promotion", false],
  ["suppression", "Suppression", false],
  ["reconciliation", "Reconciliation", false],
  ["page_audit", "Page audit", false],
  ["manual_quarantine", "Manual quarantine", false],
  ["nightly_report", "Nightly report", false],
] as const;
export const stage1ReleaseArtifactKinds = [
  "hosted_runtime_identity",
  "rollback_drill",
  "non_cohort_leak_crawl",
  "r2_recovery_drill",
  "visual_crop_coverage",
] as const;
export type Stage1ReleaseArtifactKind = typeof stage1ReleaseArtifactKinds[number];

export type Stage1ReleaseArtifact = {
  id: string;
  artifact_kind: Stage1ReleaseArtifactKind;
  environment: string;
  status: "passed" | "failed";
  cohort_identity_version: string;
  cohort_identity_hash: string;
  policy_version: string;
  app_revision: string;
  evidence: Json;
  evidence_hash: string;
  started_at: string;
  completed_at: string;
  valid_until: string;
  actor: string;
};

export type Stage1AuthoritativeArtifactBinding = {
  artifactId: string | null;
  evidenceHash: string | null;
};

export type Stage1AuthoritativeReleaseGateSnapshot = {
  schemaVersion: "stage1-release-gate-acceptance-v2";
  state: "READY" | "HOLD";
  stateHash: string;
  generatedAt: string;
  failures: string[];
  productionTargetConfigured: boolean;
  vaultSecurity: {
    apiSurfaceSafe: boolean;
    serviceRoleDataApiProfileBlocked: boolean;
    profileHttpStatus: string | number | null;
    profilePostgrestCode: string | null;
  };
  artifactBindings: Record<
    Stage1ReleaseArtifactKind,
    Stage1AuthoritativeArtifactBinding
  >;
};

type RegistryRow = Database["public"]["Tables"]["stage1_award_registry"]["Row"];
type ManifestRow = Database["public"]["Tables"]["stage1_award_source_manifest"]["Row"];
type ReconciliationRow = Database["public"]["Tables"]["shared_award_reconciliation_queue"]["Row"];
type AuditRow = Database["public"]["Tables"]["shared_award_page_audits"]["Row"];

export type Stage1EffectivePublication = {
  cohort_key: string;
  effectively_verified: boolean;
  effective_reason: string;
  evaluated_at: string;
  cohort_ready: boolean;
  cohort_readiness_reason: string;
  release_epoch: string | null;
  release_state: "pending" | "verified_beta" | "revalidation_pending" | "suspended";
  release_policy_version: string;
  release_identity_version: string;
  release_identity_hash: string;
};

export function isCanonicalStage1ReleaseEpoch(value: unknown): value is string {
  return typeof value === "string" && canonicalReleaseEpochPattern.test(value);
}

export type Stage1AppIdentity = {
  revision: string;
  policy_hash: string;
  batch_policy_hash: string;
  suppression_policy_hash: string;
  matcher_hash: string;
};

export type Stage1MigrationIdentity = {
  status: "match" | "mismatch" | "unknown";
  reason: string;
};

export type Stage1ReleaseGateInput = {
  now: Date | string;
  registry: RegistryRow[];
  manifests: ManifestRow[];
  effectivePublication: Stage1EffectivePublication[];
  latestReconciliations: Record<string, ReconciliationRow | null>;
  latestAudits: Record<string, AuditRow | null>;
  quarantineCountsByCohort: Record<string, number>;
  inviteReadiness: InviteOnlySignupReadiness;
  inviteSecurityReissues: {
    count: number | null;
    oldestAt: string | null;
  };
  appIdentity: Stage1AppIdentity;
  migrationIdentity: Stage1MigrationIdentity;
  visualNightly: VisualNightlyReport | null;
  visualWorkerRuns: WorkerRun[];
  budgets: AdminGeminiBudgetLane[];
  lanes: AdminDownstreamLane[];
  evidenceRecovery: AdminEvidenceRecoveryStatus;
  authoritativeGate: Stage1AuthoritativeReleaseGateSnapshot | null;
  releaseArtifacts: Partial<Record<Stage1ReleaseArtifactKind, Stage1ReleaseArtifact>>;
  loadErrors?: string[];
};

export type ReleaseGateState = "READY" | "HOLD" | "UNKNOWN";
export type ReleaseCheckState = "pass" | "hold" | "unknown";
export type Stage1ReleasePhase =
  | "preactivation_ready"
  | "active_ready"
  | "hold"
  | "unknown";

export type Stage1ReleaseAwardSummary = {
  launchRank: number;
  cohortKey: string;
  canonicalName: string;
  publicationState: string;
  effectiveReason: string;
  cohortReady: boolean;
  effectivelyVisible: boolean;
  verificationEpochValid: boolean;
  evidenceCheckedAt: string | null;
  completedManifestRoles: number;
  verifiedManifestRoles: number;
  missingManifestRoles: string[];
  reconciliationStatus: string;
  reconciliationAt: string | null;
  reconciliationValid: boolean;
  auditStatus: string;
  auditAt: string | null;
  auditValid: boolean;
  quarantineCount: number;
  status: "ready" | "hold";
};

export type Stage1IdentityCheck = {
  key: "app_worker" | "policy" | "batch_policy" | "suppression" | "matcher" | "migration";
  label: string;
  status: ReleaseCheckState;
  detail: string;
};

export type Stage1BudgetCheck = {
  laneKey: string;
  label: string;
  status: ReleaseCheckState;
  capUsd: number | null;
  reservedUsd: number | null;
  spentUsd: number | null;
  remainingUsd: number | null;
  resetAt: string | null;
  configurationSource: string;
};

export type Stage1LaneCheck = {
  laneKey: string;
  label: string;
  status: ReleaseCheckState;
  paid: boolean | null;
  expectedPaid: boolean;
  queueDepth: number | null;
  detail: string;
};

export type Stage1ReleaseArtifactCheck = {
  kind: Stage1ReleaseArtifactKind;
  label: string;
  status: ReleaseCheckState;
  artifactId: string | null;
  authoritativeArtifactId: string | null;
  completedAt: string | null;
  validUntil: string | null;
  evidenceHash: string | null;
  authoritativeEvidenceHash: string | null;
  detail: string;
};

export type Stage1AuthoritativeGateCheck = {
  status: ReleaseCheckState;
  databaseState: "READY" | "HOLD" | null;
  generatedAt: string | null;
  stateHash: string | null;
  failures: string[];
  productionTargetConfigured: boolean | null;
  vaultApiSurfaceSafe: boolean | null;
  serviceRoleDataApiProfileBlocked: boolean | null;
  profileHttpStatus: string | number | null;
  profilePostgrestCode: string | null;
  currentValidArtifactBindings: number;
  requiredArtifactBindings: number;
  detail: string;
};

export type Stage1ReleaseGateSummary = {
  state: ReleaseGateState;
  phase: Stage1ReleasePhase;
  generatedAt: string;
  awards: Stage1ReleaseAwardSummary[];
  registryCount: number;
  visibleCount: number;
  expectedAwardCount: 25;
  release: {
    state: string;
    epoch: string | null;
    effectiveReason: string;
    atomic: boolean;
  };
  invite: {
    status: ReleaseCheckState;
    disableSignup: boolean | null;
    detail: string;
  };
  inviteSecurityReissues: {
    status: ReleaseCheckState;
    count: number | null;
    oldestAt: string | null;
    detail: string;
  };
  identities: Stage1IdentityCheck[];
  nightly: {
    status: ReleaseCheckState;
    label: string;
    detail: string;
    finishedAt: string | null;
    acceptance: {
      requiredCohorts: 3;
      observedCohorts: number;
      healthyCohorts: number;
      consecutive: boolean;
      soakStartedAt: string | null;
      soakRequiredHours: 24;
      soakElapsedHours: number | null;
      soakComplete: boolean;
      cohorts: Array<{
        monitoringDate: string;
        status: ReleaseCheckState;
        finishedAt: string | null;
        detail: string;
      }>;
    };
  };
  budgets: Stage1BudgetCheck[];
  lanes: Stage1LaneCheck[];
  recovery: {
    status: ReleaseCheckState;
    detail: string;
    reportingShards: number;
    failed: number;
    refused: number;
    lastReportedAt: string | null;
  };
  authoritativeGate: Stage1AuthoritativeGateCheck;
  acceptanceArtifacts: Stage1ReleaseArtifactCheck[];
  safeNextAction: string;
  blockers: string[];
  unknownReasons: string[];
};

export function summarizeStage1BetaReleaseGate(
  input: Stage1ReleaseGateInput,
): Stage1ReleaseGateSummary {
  const now = input.now instanceof Date ? input.now : new Date(input.now);
  const manifestsByCohort = groupBy(input.manifests, (row) => row.cohort_key);
  const effectiveByCohort = new Map(
    input.effectivePublication.map((row) => [row.cohort_key, row]),
  );
  const sortedRegistry = [...input.registry].sort(
    (left, right) => left.launch_rank - right.launch_rank || left.canonical_name.localeCompare(right.canonical_name),
  );
  const awards = sortedRegistry.slice(0, stage1ReleaseAwardCount).map((registry) =>
    summarizeAward({
      registry,
      manifests: manifestsByCohort.get(registry.cohort_key) || [],
      effective: effectiveByCohort.get(registry.cohort_key) || null,
      reconciliation: input.latestReconciliations[registry.canonical_shared_award_id] || null,
      audit: input.latestAudits[registry.canonical_shared_award_id] || null,
      quarantineCount: input.quarantineCountsByCohort[registry.cohort_key] || 0,
      now,
    }),
  );
  while (awards.length < stage1ReleaseAwardCount) {
    const launchRank = awards.length + 1;
    awards.push(missingAward(launchRank));
  }

  const invite = summarizeInvite(input.inviteReadiness);
  const inviteSecurityReissues = summarizeInviteSecurityReissues(
    input.inviteSecurityReissues,
  );
  const identities = summarizeIdentities(input);
  const nightly = summarizeNightly(
    input.visualNightly,
    input.visualWorkerRuns,
    now,
  );
  const budgets = summarizeBudgets(input.budgets);
  const lanes = summarizeLanes(input.lanes, now);
  const recovery = summarizeRecovery(input.evidenceRecovery, now);
  const visibleCount = input.effectivePublication.filter((row) => row.effectively_verified).length;
  const releaseStates = uniqueText(input.effectivePublication.map((row) => row.release_state));
  const releaseEpochs = uniqueText(input.effectivePublication.map((row) => row.release_epoch || ""));
  const releaseReasons = uniqueText(input.effectivePublication.map((row) => row.effective_reason));
  const registryEpochs = uniqueText(input.registry.map((row) => row.release_epoch || ""));
  const canonicalReleaseEpoch = releaseEpochs.length === 1 &&
    isCanonicalStage1ReleaseEpoch(releaseEpochs[0])
    ? releaseEpochs[0]
    : null;
  const effectiveReleaseContractsValid = input.effectivePublication.every((row) =>
    effectivePublicationIdentityValid(row));
  const registryReleaseContractsValid = input.registry.every((row) =>
    row.policy_version === expectedPolicyVersion);
  const atomicRelease = visibleCount === stage1ReleaseAwardCount &&
    input.effectivePublication.length === stage1ReleaseAwardCount &&
    input.registry.length === stage1ReleaseAwardCount &&
    releaseStates.length === 1 && releaseStates[0] === "verified_beta" &&
    canonicalReleaseEpoch !== null && registryEpochs.length === 1 &&
    registryEpochs[0] === canonicalReleaseEpoch &&
    effectiveReleaseContractsValid && registryReleaseContractsValid &&
    input.effectivePublication.every((row) => row.release_epoch === canonicalReleaseEpoch) &&
    input.registry.every((row) => row.release_epoch === canonicalReleaseEpoch);
  const acceptanceArtifacts = summarizeAcceptanceArtifacts(
    input.releaseArtifacts,
    input.authoritativeGate,
    input.appIdentity,
    now,
  );
  const authoritativeGate = summarizeAuthoritativeGate(
    input.authoritativeGate,
    input.releaseArtifacts,
    now,
    atomicRelease,
  );
  const laneIdentityIssue = downstreamLaneIdentityIssue(input.lanes);
  const loadErrors = uniqueText(input.loadErrors || []);
  const unknownReasons = [
    ...loadErrors,
    ...(laneIdentityIssue ? [laneIdentityIssue] : []),
    ...(invite.status === "unknown" ? [invite.detail] : []),
    ...(inviteSecurityReissues.status === "unknown"
      ? [inviteSecurityReissues.detail]
      : []),
    ...lanes.filter((lane) => lane.status === "unknown").map((lane) => lane.detail),
    ...(recovery.status === "unknown" ? [recovery.detail] : []),
    ...(authoritativeGate.status === "unknown" ? [authoritativeGate.detail] : []),
    ...acceptanceArtifacts.filter((artifact) => artifact.status === "unknown").map((artifact) => artifact.detail),
  ];
  const cohortIdentityMismatch = stage1CohortIdentityMismatch(input.registry);
  const releaseClaimsActive = releaseStates.length === 1 && releaseStates[0] === "verified_beta";
  const blockers = [
    ...(input.registry.length === stage1ReleaseAwardCount
      ? []
      : [`The Stage 1 registry contains ${input.registry.length} awards; exactly 25 are required.`]),
    ...(cohortIdentityMismatch ? [cohortIdentityMismatch] : []),
    ...(!registryReleaseContractsValid
      ? [`Every Stage 1 registry row must use ${expectedPolicyVersion}.`]
      : []),
    ...(!effectiveReleaseContractsValid
      ? ["Every effective publication row must match the reviewed Stage 1 release policy and cohort identity."]
      : []),
    ...(visibleCount !== 0 && visibleCount !== stage1ReleaseAwardCount
      ? [`The publication result is partial (${visibleCount}/25); public release must fail closed to zero.`]
      : []),
    ...(visibleCount === stage1ReleaseAwardCount && !atomicRelease
      ? ["The 25 visible awards do not share one authoritative release epoch and state."]
      : []),
    ...(releaseClaimsActive && !atomicRelease
      ? ["The release claims to be active without exactly 25 awards on one authoritative epoch."]
      : []),
    ...awards
      .filter((award) => award.status === "hold")
      .map((award) => `${award.canonicalName}: ${award.effectiveReason}`),
    ...(invite.status === "hold" ? [invite.detail] : []),
    ...(inviteSecurityReissues.status === "hold"
      ? [inviteSecurityReissues.detail]
      : []),
    ...identities.filter((check) => check.status !== "pass").map((check) => check.detail),
    ...(nightly.status === "hold" ? [nightly.detail] : []),
    ...budgets.filter((check) => check.status !== "pass").map((check) =>
      check.status === "unknown"
        ? `${check.label}: budget status is unavailable.`
        : `${check.label}: ${budgetIssue(check)}`,
    ),
    ...lanes.filter((lane) => lane.status === "hold").map((lane) => lane.detail),
    ...(recovery.status === "hold" ? [recovery.detail] : []),
    ...(authoritativeGate.status === "hold" ? [authoritativeGate.detail] : []),
    ...acceptanceArtifacts.filter((artifact) => artifact.status === "hold").map((artifact) => artifact.detail),
  ];
  const cleanUnknownReasons = uniqueText(unknownReasons);
  const cleanBlockers = uniqueText(blockers);
  const state: ReleaseGateState = cleanUnknownReasons.length > 0
    ? "UNKNOWN"
    : cleanBlockers.length > 0
      ? "HOLD"
      : "READY";
  const phase: Stage1ReleasePhase = state === "UNKNOWN"
    ? "unknown"
    : state === "HOLD"
      ? "hold"
      : atomicRelease
        ? "active_ready"
        : "preactivation_ready";

  return {
    state,
    phase,
    generatedAt: validDate(now) ? now.toISOString() : new Date(0).toISOString(),
    awards,
    registryCount: input.registry.length,
    visibleCount,
    expectedAwardCount: stage1ReleaseAwardCount,
    release: {
      state: releaseStates.length === 1 ? releaseStates[0] : "mixed_or_missing",
      epoch: canonicalReleaseEpoch,
      effectiveReason: releaseReasons.length === 1 ? releaseReasons[0] : "mixed_or_missing",
      atomic: atomicRelease,
    },
    invite,
    inviteSecurityReissues,
    identities,
    nightly,
    budgets,
    lanes,
    recovery,
    authoritativeGate,
    acceptanceArtifacts,
    safeNextAction: safeNextAction(phase, cleanUnknownReasons, cleanBlockers),
    blockers: cleanBlockers,
    unknownReasons: cleanUnknownReasons,
  };
}

function summarizeRecovery(
  recovery: AdminEvidenceRecoveryStatus,
  now: Date,
): Stage1ReleaseGateSummary["recovery"] {
  const reportedFresh = recovery.lastReportedAt !== null &&
    timestampFresh(recovery.lastReportedAt, now);
  if (
    recovery.enabled === null || recovery.reportingShards !== 3 ||
    recovery.missingShardNumbers.length > 0 || recovery.unknownShardNumbers.length > 0 ||
    !reportedFresh
  ) {
    return {
      status: "unknown",
      detail: `R2 recovery readiness is incomplete: ${recovery.statusReason}`,
      reportingShards: recovery.reportingShards,
      failed: recovery.failed,
      refused: recovery.refused,
      lastReportedAt: recovery.lastReportedAt,
    };
  }
  const healthy = recovery.enabled === true && recovery.disabledShardNumbers.length === 0 &&
    recovery.failed === 0 && recovery.refused === 0;
  return {
    status: healthy ? "pass" : "hold",
    detail: healthy
      ? "All three current 6 PM shards enable hash-verified R2 recovery with no failed or refused restores."
      : `R2 recovery is not release-safe: ${recovery.statusReason}`,
    reportingShards: recovery.reportingShards,
    failed: recovery.failed,
    refused: recovery.refused,
    lastReportedAt: recovery.lastReportedAt,
  };
}

function summarizeAcceptanceArtifacts(
  artifacts: Stage1ReleaseGateInput["releaseArtifacts"],
  authoritativeGate: Stage1ReleaseGateInput["authoritativeGate"],
  appIdentity: Stage1AppIdentity,
  now: Date,
): Stage1ReleaseArtifactCheck[] {
  const labels: Record<Stage1ReleaseArtifactKind, string> = {
    hosted_runtime_identity: "Hosted runtime and Auth identity",
    rollback_drill: "Rollback and restoration drill",
    non_cohort_leak_crawl: "Anonymous non-cohort leak crawl",
    r2_recovery_drill: "Hash-verified R2 recovery drill",
    visual_crop_coverage: "Verified event-crop coverage",
  };
  return stage1ReleaseArtifactKinds.map((kind) => {
    if (!authoritativeGate) {
      return {
        kind,
        label: labels[kind],
        status: "unknown",
        artifactId: null,
        authoritativeArtifactId: null,
        completedAt: null,
        validUntil: null,
        evidenceHash: null,
        authoritativeEvidenceHash: null,
        detail: `${labels[kind]} cannot be verified because the authoritative database gate snapshot is unavailable.`,
      };
    }
    const authoritativeBinding = authoritativeGate.artifactBindings[kind];
    if (!authoritativeBinding.artifactId || !authoritativeBinding.evidenceHash) {
      return {
        kind,
        label: labels[kind],
        status: "hold",
        artifactId: null,
        authoritativeArtifactId: null,
        completedAt: null,
        validUntil: null,
        evidenceHash: null,
        authoritativeEvidenceHash: null,
        detail: `${labels[kind]} has no database-authoritative current-valid artifact binding.`,
      };
    }
    const artifact = artifacts[kind];
    if (!artifact) {
      return {
        kind,
        label: labels[kind],
        status: "hold",
        artifactId: null,
        authoritativeArtifactId: authoritativeBinding.artifactId,
        completedAt: null,
        validUntil: null,
        evidenceHash: null,
        authoritativeEvidenceHash: authoritativeBinding.evidenceHash,
        detail: `${labels[kind]} authoritative binding does not resolve to its exact retained artifact row.`,
      };
    }
    const authoritativeBindingMatches =
      artifact.id === authoritativeBinding.artifactId &&
      artifact.evidence_hash === authoritativeBinding.evidenceHash;
    const identityMatches = artifact.artifact_kind === kind &&
      artifact.cohort_identity_version === stage1CohortIdentityVersion &&
      artifact.cohort_identity_hash === stage1CohortIdentityHash &&
      artifact.policy_version === expectedPolicyVersion &&
      artifact.app_revision === appIdentity.revision &&
      (kind !== "hosted_runtime_identity" || artifact.environment === "production");
    const timeValid = validTimestamp(artifact.started_at) && validTimestamp(artifact.completed_at) &&
      validTimestamp(artifact.valid_until) && Date.parse(artifact.started_at) <= Date.parse(artifact.completed_at) &&
      Date.parse(artifact.completed_at) <= now.getTime() + futureClockToleranceMs &&
      Date.parse(artifact.valid_until) > now.getTime() &&
      (kind !== "hosted_runtime_identity" || hostedRuntimeTimeValid(artifact, now));
    const evidenceValid = /^[0-9a-f]{64}$/.test(artifact.evidence_hash) &&
      releaseArtifactEvidenceValid(kind, artifact.evidence, artifact, appIdentity);
    const passed = authoritativeBindingMatches && artifact.status === "passed" &&
      identityMatches && timeValid && evidenceValid;
    return {
      kind,
      label: labels[kind],
      status: passed ? "pass" : "hold",
      artifactId: artifact.id,
      authoritativeArtifactId: authoritativeBinding.artifactId,
      completedAt: artifact.completed_at,
      validUntil: artifact.valid_until,
      evidenceHash: artifact.evidence_hash,
      authoritativeEvidenceHash: authoritativeBinding.evidenceHash,
      detail: passed
        ? `${labels[kind]} passed and matches the database-authoritative current-valid ID and evidence hash.`
        : authoritativeBindingMatches
          ? `${labels[kind]} is failed, stale, malformed, or bound to a different release identity.`
          : `${labels[kind]} does not match the database-authoritative current-valid ID and evidence hash.`,
    };
  });
}

function summarizeAuthoritativeGate(
  snapshot: Stage1ReleaseGateInput["authoritativeGate"],
  artifacts: Stage1ReleaseGateInput["releaseArtifacts"],
  now: Date,
  atomicRelease: boolean,
): Stage1AuthoritativeGateCheck {
  if (!snapshot) {
    return {
      status: "unknown",
      databaseState: null,
      generatedAt: null,
      stateHash: null,
      failures: [],
      productionTargetConfigured: null,
      vaultApiSurfaceSafe: null,
      serviceRoleDataApiProfileBlocked: null,
      profileHttpStatus: null,
      profilePostgrestCode: null,
      currentValidArtifactBindings: 0,
      requiredArtifactBindings: stage1ReleaseArtifactKinds.length,
      detail: "The database-authoritative release-gate snapshot is unavailable or malformed.",
    };
  }

  const generatedAt = Date.parse(snapshot.generatedAt);
  const snapshotCurrent = Number.isFinite(generatedAt) &&
    generatedAt >= now.getTime() - authoritativeSnapshotFreshnessMs &&
    generatedAt <= now.getTime() + futureClockToleranceMs;
  const currentValidArtifactBindings = stage1ReleaseArtifactKinds.filter((kind) => {
    const binding = snapshot.artifactBindings[kind];
    const artifact = artifacts[kind];
    return Boolean(
      binding.artifactId &&
      binding.evidenceHash &&
      artifact &&
      artifact.id === binding.artifactId &&
      artifact.evidence_hash === binding.evidenceHash,
    );
  }).length;
  const expectedPostActivationFailure = "release_state_not_closed_or_mismatched";
  const databaseFailureContractSafe =
    (snapshot.state === "READY" && snapshot.failures.length === 0) ||
    (atomicRelease &&
      snapshot.state === "HOLD" &&
      snapshot.failures.length === 1 &&
      snapshot.failures[0] === expectedPostActivationFailure);
  const failures = [
    ...(!snapshotCurrent ? ["the authoritative snapshot is not current"] : []),
    ...(!databaseFailureContractSafe
      ? [atomicRelease
          ? "the database gate contains failures beyond the single expected post-activation release-state failure"
          : "the pre-activation database gate is not READY with zero failures"]
      : []),
    ...(!snapshot.productionTargetConfigured ? ["the production target is not configured"] : []),
    ...(!snapshot.vaultSecurity.apiSurfaceSafe ? ["the Vault API surface is unsafe"] : []),
    ...(!snapshot.vaultSecurity.serviceRoleDataApiProfileBlocked
      ? ["the service-role Data API can reach the Vault profile"]
      : []),
    ...(currentValidArtifactBindings !== stage1ReleaseArtifactKinds.length
      ? [`only ${currentValidArtifactBindings}/${stage1ReleaseArtifactKinds.length} current-valid artifact bindings resolve exactly`]
      : []),
  ];
  const status: ReleaseCheckState = failures.length === 0 ? "pass" : "hold";
  const reportedFailures = snapshot.failures.length > 0
    ? ` Database gate reports ${snapshot.state}: ${snapshot.failures.join(", ")}.`
    : ` Database gate reports ${snapshot.state} with no failures.`;

  return {
    status,
    databaseState: snapshot.state,
    generatedAt: snapshot.generatedAt,
    stateHash: snapshot.stateHash,
    failures: snapshot.failures,
    productionTargetConfigured: snapshot.productionTargetConfigured,
    vaultApiSurfaceSafe: snapshot.vaultSecurity.apiSurfaceSafe,
    serviceRoleDataApiProfileBlocked:
      snapshot.vaultSecurity.serviceRoleDataApiProfileBlocked,
    profileHttpStatus: snapshot.vaultSecurity.profileHttpStatus,
    profilePostgrestCode: snapshot.vaultSecurity.profilePostgrestCode,
    currentValidArtifactBindings,
    requiredArtifactBindings: stage1ReleaseArtifactKinds.length,
    detail: status === "pass"
      ? `The database current-valid selectors bind all ${stage1ReleaseArtifactKinds.length} exact artifact IDs and evidence hashes; the production target, Vault controls, and database failure contract are safe.${reportedFailures}`
      : `Database authority is not release-safe: ${failures.join("; ")}.${reportedFailures}`,
  };
}

function releaseArtifactEvidenceValid(
  kind: Stage1ReleaseArtifactKind,
  value: Json,
  artifact: Stage1ReleaseArtifact,
  appIdentity: Stage1AppIdentity,
) {
  if (!isObject(value)) return false;
  if (kind === "hosted_runtime_identity") {
    return hostedRuntimeEvidenceValid(value, artifact, appIdentity);
  }
  if (kind === "rollback_drill") {
    return value.rollback_succeeded === true && value.restore_succeeded === true &&
      Boolean(cleanText(value.before_state_hash)) && Boolean(cleanText(value.rollback_state_hash)) &&
      Boolean(cleanText(value.restored_state_hash));
  }
  if (kind === "non_cohort_leak_crawl") {
    return value.anonymous === true && positiveInteger(value.routes_checked) &&
      value.non_cohort_leaks === 0 && value.unexpected_stage1_leaks === 0 &&
      Boolean(cleanText(value.base_url));
  }
  if (kind === "r2_recovery_drill") {
    return value.hash_verified === true && positiveInteger(value.recovered_objects) &&
      value.failed_objects === 0 && value.refused_objects === 0;
  }
  return nonNegativeInteger(value.eligible_events) &&
    value.unverified_publishable_events === 0 && value.terminal_failures === 0 &&
    value.r2_hashes_verified === true && /^[0-9a-f]{64}$/.test(cleanText(value.coverage_set_hash));
}

function hostedRuntimeTimeValid(artifact: Stage1ReleaseArtifact, now: Date) {
  const startedAt = Date.parse(artifact.started_at);
  const completedAt = Date.parse(artifact.completed_at);
  const validUntil = Date.parse(artifact.valid_until);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    !Number.isFinite(validUntil)
  ) return false;
  return completedAt >= now.getTime() - hostedRuntimeFreshnessMs &&
    validUntil <= completedAt + hostedRuntimeMaximumValidityMs;
}

function hostedRuntimeEvidenceValid(
  value: Record<string, unknown>,
  artifact: Stage1ReleaseArtifact,
  appIdentity: Stage1AppIdentity,
) {
  const sha256 = /^[0-9a-f]{64}$/;
  const measurementId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const projectRef = cleanText(value.supabase_project_ref);
  const productionOrigin = cleanText(value.production_app_origin);
  const supabaseOrigin = cleanText(value.supabase_origin);
  const measuredAt = Date.parse(cleanText(value.measured_at));
  const observedAt = Date.parse(cleanText(value.observed_at));
  const startedAt = Date.parse(artifact.started_at);
  const completedAt = Date.parse(artifact.completed_at);
  const measurementWindowValid = Number.isFinite(measuredAt) &&
    measuredAt >= startedAt - futureClockToleranceMs &&
    measuredAt <= completedAt + futureClockToleranceMs;
  const observationWindowValid = Number.isFinite(observedAt) &&
    Math.abs(completedAt - observedAt) <= futureClockToleranceMs;

  return value.producer_contract === "awardping.stage1.release-evidence-producer.v2" &&
    sha256.test(cleanText(value.producer_source_sha256)) &&
    measurementId.test(cleanText(value.measurement_id)) &&
    measurementWindowValid &&
    positiveIntegerScalar(value.target_config_version) &&
    sha256.test(cleanText(value.target_config_hash)) &&
    productionOrigin.startsWith("https://") &&
    /^[a-z0-9]{20}$/.test(projectRef) &&
    supabaseOrigin === `https://${projectRef}.supabase.co` &&
    value.schema_version === "awardping.stage1.hosted-runtime-identity.v2" &&
    value.measurement_method === "direct_no_redirect_https_and_vault_profile_get_v2" &&
    value.disable_signup === true &&
    value.identity_http_status === 200 &&
    value.auth_http_status === 200 &&
    value.identity_redirected === false &&
    value.auth_redirected === false &&
    value.base_url === productionOrigin &&
    value.identity_url === `${productionOrigin}/api/monitoring-policy-identity` &&
    value.auth_settings_url === `${supabaseOrigin}/auth/v1/settings` &&
    value.deployment_provider === "vercel" &&
    Boolean(cleanText(value.deployment_project_id)) &&
    value.app_revision === artifact.app_revision &&
    value.app_revision === appIdentity.revision &&
    value.policy_hash === appIdentity.policy_hash &&
    value.batch_policy_hash === appIdentity.batch_policy_hash &&
    value.suppression_policy_hash === appIdentity.suppression_policy_hash &&
    value.matcher_hash === appIdentity.matcher_hash &&
    sha256.test(cleanText(value.matcher_hash)) &&
    sha256.test(cleanText(value.identity_response_sha256)) &&
    sha256.test(cleanText(value.auth_response_sha256)) &&
    value.vault_profile_url ===
      `${supabaseOrigin}/rest/v1/decrypted_secrets?select=id&limit=1` &&
    value.vault_profile_http_status === 406 &&
    value.vault_profile_postgrest_code === "PGRST106" &&
    value.vault_profile_exposed === false &&
    value.vault_profile_redirected === false &&
    sha256.test(cleanText(value.vault_profile_response_sha256)) &&
    observationWindowValid;
}

function positiveIntegerScalar(value: unknown) {
  return (typeof value === "number" || typeof value === "string") &&
    /^[1-9][0-9]*$/.test(String(value));
}

function positiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0;
}

function effectivePublicationIdentityValid(row: Stage1EffectivePublication) {
  return row.release_policy_version === expectedPolicyVersion &&
    row.release_identity_version === stage1CohortIdentityVersion &&
    row.release_identity_hash === stage1CohortIdentityHash;
}

function effectivePublicationContractValid(
  row: Stage1EffectivePublication | null,
  registryEpoch: string | null,
) {
  if (!row || !effectivePublicationIdentityValid(row)) return false;
  if (row.release_state === "verified_beta") {
    return isCanonicalStage1ReleaseEpoch(row.release_epoch) &&
      row.release_epoch === registryEpoch;
  }
  return row.release_epoch === null && registryEpoch === null;
}

function summarizeAward({
  registry,
  manifests,
  effective,
  reconciliation,
  audit,
  quarantineCount,
  now,
}: {
  registry: RegistryRow;
  manifests: ManifestRow[];
  effective: Stage1EffectivePublication | null;
  reconciliation: ReconciliationRow | null;
  audit: AuditRow | null;
  quarantineCount: number;
  now: Date;
}): Stage1ReleaseAwardSummary {
  const manifestByRole = new Map(manifests.map((row) => [row.source_role, row]));
  const completedRoles = stage1ReleaseManifestRoles.filter((role) => {
    const manifest = manifestByRole.get(role);
    return manifest ? manifestComplete(manifest) : false;
  });
  const verifiedRoles = stage1ReleaseManifestRoles.filter((role) => {
    const manifest = manifestByRole.get(role);
    return manifest
      ? manifestComplete(manifest) && manifestVerificationTimeValid(manifest, now)
      : false;
  });
  const missingRoles = stage1ReleaseManifestRoles.filter((role) => !completedRoles.includes(role));
  const verificationEpochValid = registry.policy_version === expectedPolicyVersion &&
    effectivePublicationContractValid(effective, registry.release_epoch) &&
    durableTimestampValid(registry.evidence_checked_at, now) &&
    durableTimestampValid(registry.last_verified_at, now);
  const reconciliationValid = reconciliation?.status === "succeeded" &&
    durableTimestampValid(reconciliation.completed_at, now);
  const auditValid = audit?.audit_status === "passed" &&
    durableTimestampValid(audit.created_at, now);
  const effectivelyVisible = effective?.effectively_verified === true;
  const cohortReady = effective?.cohort_ready === true;
  const status = cohortReady && verificationEpochValid && completedRoles.length === stage1ReleaseManifestRoles.length &&
    verifiedRoles.length === stage1ReleaseManifestRoles.length && reconciliationValid && auditValid && quarantineCount === 0
    ? "ready"
    : "hold";

  return {
    launchRank: registry.launch_rank,
    cohortKey: registry.cohort_key,
    canonicalName: registry.canonical_name,
    publicationState: registry.publication_state,
    effectiveReason: cohortReady
      ? "Award-level verification is ready."
      : cleanText(effective?.cohort_readiness_reason) || "Award-level publication readiness is missing.",
    cohortReady,
    effectivelyVisible,
    verificationEpochValid,
    evidenceCheckedAt: registry.evidence_checked_at,
    completedManifestRoles: completedRoles.length,
    verifiedManifestRoles: verifiedRoles.length,
    missingManifestRoles: missingRoles,
    reconciliationStatus: reconciliation?.status || "missing",
    reconciliationAt: reconciliation?.completed_at || reconciliation?.created_at || null,
    reconciliationValid,
    auditStatus: audit?.audit_status || "missing",
    auditAt: audit?.created_at || null,
    auditValid,
    quarantineCount,
    status,
  };
}

function missingAward(launchRank: number): Stage1ReleaseAwardSummary {
  return {
    launchRank,
    cohortKey: `missing-stage1-award-${launchRank}`,
    canonicalName: `Missing Stage 1 award #${launchRank}`,
    publicationState: "missing",
    effectiveReason: "No registry row exists for this required release position.",
    cohortReady: false,
    effectivelyVisible: false,
    verificationEpochValid: false,
    evidenceCheckedAt: null,
    completedManifestRoles: 0,
    verifiedManifestRoles: 0,
    missingManifestRoles: [...stage1ReleaseManifestRoles],
    reconciliationStatus: "missing",
    reconciliationAt: null,
    reconciliationValid: false,
    auditStatus: "missing",
    auditAt: null,
    auditValid: false,
    quarantineCount: 0,
    status: "hold",
  };
}

function summarizeInvite(readiness: InviteOnlySignupReadiness) {
  return {
    status: readiness.status === "ready" ? "pass" as const : readiness.status === "unsafe" ? "hold" as const : "unknown" as const,
    disableSignup: readiness.disableSignup,
    detail: readiness.reason,
  };
}

function summarizeInviteSecurityReissues(
  evidence: Stage1ReleaseGateInput["inviteSecurityReissues"],
) {
  if (evidence.count === null || !Number.isInteger(evidence.count) || evidence.count < 0) {
    return {
      status: "unknown" as const,
      count: null,
      oldestAt: evidence.oldestAt,
      detail: "The exact unresolved invite-security reissue count is unavailable.",
    };
  }
  if (evidence.count > 0) {
    return {
      status: "hold" as const,
      count: evidence.count,
      oldestAt: evidence.oldestAt,
      detail: `${evidence.count} advisor invitation${evidence.count === 1 ? "" : "s"} still require${evidence.count === 1 ? "s" : ""} secure reissue${evidence.oldestAt ? `; oldest ${evidence.oldestAt}` : ""}.`,
    };
  }
  return {
    status: "pass" as const,
    count: 0,
    oldestAt: null,
    detail: "No pending or replacement-ready invite-security reissues remain.",
  };
}

function summarizeIdentities(input: Stage1ReleaseGateInput): Stage1IdentityCheck[] {
  const runById = new Map(input.visualWorkerRuns.map((run) => [run.id, run]));
  const shardRuns = (input.visualNightly?.shards || [])
    .map((shard) => runById.get(shard.runId) || null)
    .filter((run): run is WorkerRun => Boolean(run));
  const app = input.appIdentity;
  return [
    identityCheck("app_worker", "App / worker revision", app.revision, shardRuns, (run) => jsonText(run.metadata, "worker_revision")),
    identityCheck("policy", "Monitoring policy", app.policy_hash, shardRuns, (run) => nestedJsonText(run.metadata, "monitoring_policy_bundle", "hash")),
    identityCheck("batch_policy", "Review policy", app.batch_policy_hash, shardRuns, (run) => nestedJsonText(run.metadata, "monitoring_policy", "hash")),
    identityCheck("suppression", "Suppression policy", app.suppression_policy_hash, shardRuns, (run) => nestedJsonText(run.metadata, "suppression_policy", "hash")),
    identityCheck("matcher", "Matcher", app.matcher_hash, shardRuns, (run) => jsonText(run.metadata, "matcher_digest")),
    {
      key: "migration",
      label: "Release migrations",
      status: input.migrationIdentity.status === "match" ? "pass" : input.migrationIdentity.status === "mismatch" ? "hold" : "unknown",
      detail: input.migrationIdentity.reason,
    },
  ];
}

function identityCheck(
  key: Stage1IdentityCheck["key"],
  label: string,
  expected: string,
  runs: WorkerRun[],
  readValue: (run: WorkerRun) => string,
): Stage1IdentityCheck {
  const expectedValue = cleanText(expected);
  const values = runs.map(readValue).map(cleanText);
  if (!expectedValue || expectedValue === "unavailable" || runs.length === 0 || values.some((value) => !value)) {
    return { key, label, status: "unknown", detail: `${label} could not be verified across the latest true 6 PM shards.` };
  }
  const matches = values.every((value) => value === expectedValue);
  return {
    key,
    label,
    status: matches ? "pass" : "hold",
    detail: matches
      ? `${label} matches across the app and latest true 6 PM shards.`
      : `${label} does not match across the app and latest true 6 PM shards.`,
  };
}

function summarizeNightly(
  report: VisualNightlyReport | null,
  workerRuns: WorkerRun[],
  now: Date,
) {
  const latest = summarizeLatestNightlyReport(report);
  const historicalReports = buildNightlyAcceptanceReports(workerRuns, now);
  const acceptanceReports = historicalReports.slice(0, nightlyAcceptanceCohortCount);
  const acceptanceCohorts = acceptanceReports.map((cohort) => ({
    monitoringDate: cohort.monitoringDate,
    status: nightlyReportHealthy(cohort) ? "pass" as const : "hold" as const,
    finishedAt: cohort.finishedAt,
    detail: nightlyReportHealthy(cohort)
      ? "Normal scheduled cohort completed all three exact, independently hashed source partitions."
      : cohort.summary,
  }));
  const healthyCohorts = acceptanceCohorts.filter((cohort) => cohort.status === "pass").length;
  const consecutive = acceptanceReports.length === nightlyAcceptanceCohortCount &&
    consecutiveMonitoringDates(acceptanceReports.map((cohort) => cohort.monitoringDate));
  const healthyStreak = latestConsecutiveHealthyNightlyStreak(historicalReports);
  const qualifyingCohort = healthyStreak.length >= nightlyAcceptanceCohortCount
    ? healthyStreak[healthyStreak.length - nightlyAcceptanceCohortCount]
    : null;
  const soakStartedAt = qualifyingCohort?.finishedAt || null;
  const soakStartedMs = Date.parse(soakStartedAt || "");
  const soakElapsedMs = Number.isFinite(soakStartedMs) && validDate(now)
    ? now.getTime() - soakStartedMs
    : Number.NaN;
  const soakElapsedHours = Number.isFinite(soakElapsedMs)
    ? Math.max(0, Math.round((soakElapsedMs / (60 * 60 * 1_000)) * 10) / 10)
    : null;
  const soakComplete = Number.isFinite(soakElapsedMs) && soakElapsedMs >= nightlyAcceptanceSoakMs;
  const currentHealthy = report ? nightlyReportHealthy(report) : false;
  const latestHistoryMatches = Boolean(
    report && acceptanceReports[0]?.monitoringDate === report.monitoringDate,
  );
  const acceptanceComplete = currentHealthy && latestHistoryMatches &&
    acceptanceReports.length === nightlyAcceptanceCohortCount &&
    healthyCohorts === nightlyAcceptanceCohortCount && consecutive && soakComplete;
  const acceptance = {
    requiredCohorts: nightlyAcceptanceCohortCount,
    observedCohorts: acceptanceReports.length,
    healthyCohorts,
    consecutive,
    soakStartedAt,
    soakRequiredHours: 24 as const,
    soakElapsedHours,
    soakComplete,
    cohorts: acceptanceCohorts,
  };

  if (!report) return { ...latest, acceptance };

  return {
    ...latest,
    status: acceptanceComplete ? "pass" as const : "hold" as const,
    label: `${report.monitoringDate} · ${report.status} · ${report.completedShards}/${report.expectedShards} shards`,
    detail: acceptanceComplete
      ? "Three consecutive normal 6 PM cohorts completed exact source inventories, and the 24-hour soak is complete."
      : nightlyAcceptanceFailure({
          report,
          currentHealthy,
          latestHistoryMatches,
          acceptanceReports,
          healthyCohorts,
          consecutive,
          soakElapsedHours,
        }),
    acceptance,
  };
}

function buildNightlyAcceptanceReports(workerRuns: WorkerRun[], now: Date) {
  const runsByMonitoringDate = new Map<string, WorkerRun[]>();
  for (const run of workerRuns) {
    if (workerRunIsFutureDated(run, now)) continue;
    const monitoringDate = normalScheduledMonitoringDate(run);
    if (!monitoringDate) continue;
    runsByMonitoringDate.set(monitoringDate, [
      ...(runsByMonitoringDate.get(monitoringDate) || []),
      run,
    ]);
  }

  return [...runsByMonitoringDate.entries()]
    .map(([monitoringDate, runs]) => {
      const latestStart = [...runs]
        .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at))[0]
        ?.started_at;
      const historicalReport = latestStart
        ? buildVisualNightlyReport(runs, new Date(latestStart))
        : null;
      return historicalReport?.monitoringDate === monitoringDate ? historicalReport : null;
    })
    .filter((historicalReport): historicalReport is VisualNightlyReport => Boolean(historicalReport))
    .sort((left, right) => right.monitoringDate.localeCompare(left.monitoringDate));
}

function latestConsecutiveHealthyNightlyStreak(reports: VisualNightlyReport[]) {
  const streak: VisualNightlyReport[] = [];
  for (const report of reports) {
    if (!nightlyReportHealthy(report)) break;
    if (streak.length > 0) {
      const previous = streak[streak.length - 1];
      if (!adjacentMonitoringDates(previous.monitoringDate, report.monitoringDate)) break;
    }
    streak.push(report);
  }
  return streak;
}

function workerRunIsFutureDated(run: WorkerRun, now: Date) {
  if (!validDate(now)) return true;
  const startMs = Date.parse(run.started_at);
  const finishMs = Date.parse(run.finished_at || "");
  return !Number.isFinite(startMs) || startMs > now.getTime() ||
    (run.finished_at !== null && (!Number.isFinite(finishMs) || finishMs > now.getTime()));
}

function normalScheduledMonitoringDate(run: WorkerRun) {
  if (!/^local-visual-snapshot-worker-shard-[1-3]-of-3$/i.test(run.worker_name)) return null;
  if (!isObject(run.metadata)) return null;
  const identity = isObject(run.metadata.run_identity) ? run.metadata.run_identity : {};
  const options = isObject(run.metadata.options) ? run.metadata.options : {};
  const classification = classifyScheduledNightlyVisualRun({
    startedAt: run.started_at,
    runIdentity: identity,
    options,
  });
  const monitoringDate = cleanText(identity.monitoring_date);
  const cohortId = cleanText(identity.cohort_id);
  const shardCount = Number(identity.shard_count);
  const shardIndex = Number(identity.shard_index);
  const exactIdentity =
    cleanText(run.metadata.kind) === "visual_snapshot" &&
    cleanText(identity.workflow) === "visual_capture" &&
    cleanText(identity.timezone) === "America/Chicago" &&
    /^\d{4}-\d{2}-\d{2}$/.test(monitoringDate) &&
    cohortId === `visual-nightly:${monitoringDate}` &&
    cleanText(options.run_cohort_id) === cohortId &&
    shardCount === 3 && Number.isInteger(shardIndex) && shardIndex >= 0 && shardIndex < 3 &&
    monitoringDateForTimestamp(run.started_at) === monitoringDate;
  return classification.eligible && exactIdentity ? monitoringDate : null;
}

function nightlyReportHealthy(report: VisualNightlyReport) {
  return report.isLatestDueWindow && report.status === "healthy" && report.expectedShards === 3 &&
    report.observedShards === 3 && report.completedShards === 3 && report.missingShards.length === 0 &&
    report.failed === 0 && report.incidents === 0 && report.loaded > 0 && report.checked > 0 &&
    report.inventoryComplete && report.inventoryProofComplete &&
    report.globalSourceCount === report.loaded &&
    report.partitionSourceCountSum === report.globalSourceCount &&
    Boolean(report.globalSourceHash) && report.shards.every((shard) =>
      shard.loaded > 0 && shard.checked > 0 && shard.inventoryComplete &&
      shard.inventoryProofComplete && shard.globalSourceCount === report.globalSourceCount &&
      shard.globalSourceHash === report.globalSourceHash &&
      shard.expectedShardSourceCount === shard.loaded &&
      shard.loadedShardSourceCount === shard.loaded &&
      shard.expectedShardSourceHash === shard.loadedShardSourceHash);
}

function consecutiveMonitoringDates(monitoringDates: string[]) {
  if (monitoringDates.length !== nightlyAcceptanceCohortCount) return false;
  const dates = monitoringDates.map((value) => Date.parse(`${value}T00:00:00.000Z`));
  return dates.every(Number.isFinite) && dates.every((date, index) =>
    index === 0 || dates[index - 1] - date === 24 * 60 * 60 * 1_000);
}

function adjacentMonitoringDates(newer: string, older: string) {
  const newerMs = Date.parse(`${newer}T00:00:00.000Z`);
  const olderMs = Date.parse(`${older}T00:00:00.000Z`);
  return Number.isFinite(newerMs) && Number.isFinite(olderMs) &&
    newerMs - olderMs === 24 * 60 * 60 * 1_000;
}

function monitoringDateForTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const local = new Date(Date.UTC(
    Number(byType.get("year")),
    Number(byType.get("month")) - 1,
    Number(byType.get("day")),
  ));
  if (Number(byType.get("hour")) < 18) local.setUTCDate(local.getUTCDate() - 1);
  return local.toISOString().slice(0, 10);
}

function nightlyAcceptanceFailure({
  report,
  currentHealthy,
  latestHistoryMatches,
  acceptanceReports,
  healthyCohorts,
  consecutive,
  soakElapsedHours,
}: {
  report: VisualNightlyReport;
  currentHealthy: boolean;
  latestHistoryMatches: boolean;
  acceptanceReports: VisualNightlyReport[];
  healthyCohorts: number;
  consecutive: boolean;
  soakElapsedHours: number | null;
}) {
  if (!currentHealthy) return report.summary;
  if (!latestHistoryMatches) {
    return "The latest due 6 PM result is not represented by an exact normal scheduled cohort in worker history.";
  }
  if (acceptanceReports.length < nightlyAcceptanceCohortCount) {
    return `Only ${acceptanceReports.length}/3 exact normal scheduled 6 PM cohorts are available; repair and targeted runs do not count.`;
  }
  if (!consecutive) {
    return "The three latest normal scheduled 6 PM cohorts are not on consecutive monitoring dates.";
  }
  if (healthyCohorts < nightlyAcceptanceCohortCount) {
    const failed = acceptanceReports.find((cohort) => !nightlyReportHealthy(cohort));
    return failed
      ? `${failed.monitoringDate} did not pass exact-inventory acceptance: ${failed.summary}`
      : "One of the three required 6 PM cohorts did not pass exact-inventory acceptance.";
  }
  return `The 24-hour soak is still in progress (${soakElapsedHours ?? 0}/24 hours since the third qualifying cohort completed).`;
}

function summarizeLatestNightlyReport(report: VisualNightlyReport | null) {
  if (!report) {
    return {
      status: "hold" as const,
      label: "No true scheduled 6 PM result",
      detail: "The latest due 6 PM scheduled shard result is missing.",
      finishedAt: null,
    };
  }
  const healthy = report.isLatestDueWindow && report.status === "healthy" && report.expectedShards === 3 &&
    report.observedShards === 3 && report.completedShards === 3 && report.missingShards.length === 0 &&
    report.failed === 0 && report.incidents === 0 && report.loaded > 0 && report.checked > 0 &&
    report.inventoryComplete && report.inventoryProofComplete &&
    report.globalSourceCount === report.loaded &&
    report.partitionSourceCountSum === report.globalSourceCount &&
    Boolean(report.globalSourceHash) && report.shards.every((shard) =>
      shard.loaded > 0 && shard.checked > 0 && shard.inventoryComplete &&
      shard.inventoryProofComplete && shard.globalSourceCount === report.globalSourceCount &&
      shard.globalSourceHash === report.globalSourceHash &&
      shard.expectedShardSourceCount === shard.loaded &&
      shard.loadedShardSourceCount === shard.loaded &&
      shard.expectedShardSourceHash === shard.loadedShardSourceHash);
  return {
    status: healthy ? "pass" as const : "hold" as const,
    label: `${report.monitoringDate} · ${report.status} · ${report.completedShards}/${report.expectedShards} shards`,
    detail: healthy
      ? "Latest true 6 PM scheduled shard cohort completed its independently hashed source inventory cleanly."
      : report.summary,
    finishedAt: report.finishedAt,
  };
}

function summarizeBudgets(budgets: AdminGeminiBudgetLane[]): Stage1BudgetCheck[] {
  const byKey = new Map(budgets.map((budget) => [budget.laneKey, budget]));
  return expectedBudgetLanes.map((laneKey) => {
    const budget = byKey.get(laneKey);
    if (!budget) {
      return {
        laneKey,
        label: laneKey === "new_page_review" ? "New page review" : "Changed page review",
        status: "unknown" as const,
        capUsd: null,
        reservedUsd: null,
        spentUsd: null,
        remainingUsd: null,
        resetAt: null,
        configurationSource: "Unavailable",
      };
    }
    const validAmounts = [budget.capUsd, budget.reservedUsd, budget.spentUsd, budget.remainingUsd]
      .every((value) => Number.isFinite(value) && value >= 0);
    const expectedRemaining = budget.capUsd - budget.reservedUsd - budget.spentUsd;
    const healthy = validAmounts && budget.capUsd === 5 &&
      budget.reservedUsd + budget.spentUsd <= budget.capUsd + 0.000_001 &&
      Math.abs(budget.remainingUsd - expectedRemaining) <= 0.000_001 &&
      validTimestamp(budget.resetAt || "");
    return { ...budget, status: healthy ? "pass" as const : "hold" as const };
  });
}

function summarizeLanes(
  lanes: AdminDownstreamLane[],
  now: Date,
): Stage1LaneCheck[] {
  const byKey = groupBy(lanes, (lane) => lane.laneKey);
  return expectedDownstreamLanes.map(([laneKey, label, expectedPaid]) => {
    const matches = byKey.get(laneKey) || [];
    if (matches.length !== 1) {
      return {
        laneKey,
        label,
        status: "unknown",
        paid: null,
        expectedPaid,
        queueDepth: null,
        detail: matches.length === 0
          ? `${label}: the required downstream lane is missing.`
          : `${label}: duplicate downstream lane rows make health ambiguous.`,
      };
    }

    const lane = matches[0];
    const queueAgeLane = [
      "new_page_review",
      "changed_page_review",
      "feedback_promotion",
      "reconciliation",
    ].includes(laneKey);
    const invalidTimestamp = [
      lane.oldestItemAt,
      lane.nextSlaDueAt,
      lane.leaseExpiresAt,
      lane.nextRetryAt,
      lane.lastStartedAt,
      lane.lastFinishedAt,
      lane.lastSucceededAt,
      lane.lastFailedAt,
    ].some((value) => value !== null && !validTimestamp(value));
    const incomplete =
      !lane.policySource.trim() ||
      lane.timeoutSeconds <= 0 ||
      lane.leaseTtlSeconds <= 0 ||
      (queueAgeLane && lane.oldestItemSlaSeconds <= 0) ||
      !Number.isInteger(lane.queueDepth) ||
      lane.queueDepth < 0 ||
      (lane.queueDepth > 0 && !lane.oldestItemAt) ||
      (lane.lastStatus === "claimed" && !lane.leaseExpiresAt) ||
      invalidTimestamp;
    if (incomplete) {
      return {
        laneKey,
        label,
        status: "unknown",
        paid: lane.paid,
        expectedPaid,
        queueDepth: lane.queueDepth,
        detail: `${label}: lease, timeout, queue-age, or policy evidence is incomplete.`,
      };
    }

    const runtime = downstreamLaneRuntimeState(lane, now);
    const issues = [
      ...(!lane.enabled ? ["disabled"] : []),
      ...(lane.paid !== expectedPaid
        ? [expectedPaid ? "must be a paid lane" : "must not create an API charge"]
        : []),
      ...(runtime.expiredLease ? ["lease expired"] : []),
      ...(runtime.overdue ? [queueAgeLane ? "oldest-item SLA breached" : "refresh cadence SLA breached"] : []),
      ...(runtime.overdueUnclaimed ? ["overdue work is unclaimed"] : []),
    ];
    return {
      laneKey,
      label,
      status: issues.length === 0 ? "pass" : "hold",
      paid: lane.paid,
      expectedPaid,
      queueDepth: lane.queueDepth,
      detail: issues.length === 0
        ? `${label}: enabled, correctly billed, and within lease/SLA limits (${lane.queueDepth} queued).`
        : `${label}: ${issues.join("; ")}.`,
    };
  });
}

function downstreamLaneIdentityIssue(lanes: AdminDownstreamLane[]) {
  const expected = new Set<string>(expectedDownstreamLanes.map(([laneKey]) => laneKey));
  const actual = lanes.map((lane) => lane.laneKey);
  const unexpected = uniqueText(actual.filter((laneKey) => !expected.has(laneKey)));
  const uniqueActual = new Set(actual);
  if (
    lanes.length === expectedDownstreamLanes.length &&
    uniqueActual.size === expectedDownstreamLanes.length &&
    unexpected.length === 0 &&
    [...expected].every((laneKey) => uniqueActual.has(laneKey))
  ) {
    return null;
  }
  return `Downstream lane identity is incomplete or unexpected; exactly these eight keys are required: ${[...expected].join(", ")}.`;
}

function budgetIssue(check: Stage1BudgetCheck) {
  if (check.capUsd !== 5) return "the effective daily cap is not $5";
  if (!validTimestamp(check.resetAt || "")) return "the reset time is unavailable";
  return "reserved, spent, and remaining amounts are inconsistent or exceed the daily cap";
}

function manifestComplete(manifest: ManifestRow) {
  if (!(["present", "combined", "not_published"] as string[]).includes(manifest.manifest_status)) return false;
  if (manifest.policy_version !== expectedPolicyVersion || !isObject(manifest.evidence)) return false;
  const evidence = manifest.evidence;
  const factCandidates = Array.isArray(evidence.fact_candidate_ids) ? evidence.fact_candidate_ids : [];
  return manifest.source_ids.length > 0 &&
    evidence.official === true &&
    Boolean(cleanText(evidence.source_url)) &&
    Boolean(cleanText(evidence.supporting_text)) &&
    isObject(evidence.source_bindings) &&
    validTimestamp(cleanText(evidence.captured_at)) &&
    validTimestamp(cleanText(evidence.r2_verified_at)) &&
    validTimestamp(cleanText(evidence.local_verified_at)) &&
    Boolean(cleanText(evidence.cycle)) &&
    ["passed", "verified", "not_applicable"].includes(cleanText(evidence.reconciliation_status)) &&
    cleanText(evidence.policy_version) === expectedPolicyVersion &&
    (manifest.manifest_status === "not_published" || factCandidates.length > 0);
}

function manifestVerificationTimeValid(manifest: ManifestRow, now: Date) {
  if (!isObject(manifest.evidence)) return false;
  return durableTimestampValid(manifest.checked_at, now) &&
    durableTimestampValid(cleanText(manifest.evidence.captured_at), now) &&
    durableTimestampValid(cleanText(manifest.evidence.r2_verified_at), now) &&
    durableTimestampValid(cleanText(manifest.evidence.local_verified_at), now);
}

function durableTimestampValid(value: string | null | undefined, now: Date) {
  const timestamp = Date.parse(value || "");
  const nowMs = now.getTime();
  return Number.isFinite(timestamp) && Number.isFinite(nowMs) &&
    timestamp <= nowMs + futureClockToleranceMs;
}

function timestampFresh(value: string | null | undefined, now: Date) {
  const timestamp = Date.parse(value || "");
  const nowMs = now.getTime();
  return Number.isFinite(timestamp) && Number.isFinite(nowMs) &&
    timestamp >= nowMs - evidenceFreshnessMs && timestamp <= nowMs + futureClockToleranceMs;
}

function safeNextAction(phase: Stage1ReleasePhase, unknownReasons: string[], blockers: string[]) {
  if (phase === "preactivation_ready") return "All pre-activation checks pass and the cohort remains private. Review the immutable acceptance evidence, then run the separate atomic activation step.";
  if (phase === "active_ready") return "Stage 1 is active and all release checks pass. Continue normal monitoring; any new blocker must fail closed before the next publication change.";
  if (phase === "unknown") return `Keep release closed and restore the missing verification: ${unknownReasons[0] || "release evidence unavailable"}`;
  return `Keep release on hold and resolve: ${blockers[0] || "the first reported blocker"}`;
}

function groupBy<T>(values: T[], key: (value: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    grouped.set(groupKey, [...(grouped.get(groupKey) || []), value]);
  }
  return grouped;
}

function isObject(value: Json | unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonText(value: Json, key: string) {
  return isObject(value) ? cleanText(value[key]) : "";
}

function nestedJsonText(value: Json, key: string, nestedKey: string) {
  if (!isObject(value) || !isObject(value[key])) return "";
  return cleanText(value[key][nestedKey]);
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function uniqueText(values: string[]) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function validDate(value: Date) {
  return Number.isFinite(value.getTime());
}

function validTimestamp(value: string) {
  return Number.isFinite(Date.parse(value));
}
