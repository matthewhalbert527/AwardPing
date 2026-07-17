import { describe, expect, it } from "vitest";
import type {
  AdminDownstreamLane,
  AdminGeminiBudgetLane,
} from "@/lib/admin-worker-operations";
import type { Database } from "@/lib/database.types";
import {
  stage1ReleaseManifestRoles,
  summarizeStage1BetaReleaseGate,
  type Stage1ReleaseGateInput,
} from "@/lib/stage1-release-gate-summary";
import {
  stage1CohortIdentity,
  stage1CohortIdentityHash,
  stage1CohortIdentityVersion,
} from "@/lib/stage1-cohort-identity";
import { buildVisualNightlyReport } from "@/lib/admin-run-report";
import { buildVisualSourceInventoryProof } from "../../scripts/lib/visual-source-inventory-proof.mjs";

type RegistryRow = Database["public"]["Tables"]["stage1_award_registry"]["Row"];
type ManifestRow = Database["public"]["Tables"]["stage1_award_source_manifest"]["Row"];
type WorkerRun = Database["public"]["Tables"]["local_worker_runs"]["Row"];

const now = "2026-07-17T12:00:00.000Z";

describe("summarizeStage1BetaReleaseGate", () => {
  it("returns READY only when all 25 awards and shared release checks pass", () => {
    const summary = summarizeStage1BetaReleaseGate(readyInput());

    expect(summary.state).toBe("READY");
    expect(summary.registryCount).toBe(25);
    expect(summary.visibleCount).toBe(25);
    expect(summary.awards).toHaveLength(25);
    expect(summary.awards.every((award) => award.status === "ready")).toBe(true);
    expect(summary.release.atomic).toBe(true);
    expect(summary.nightly).toMatchObject({
      status: "pass",
      acceptance: {
        requiredCohorts: 3,
        observedCohorts: 3,
        healthyCohorts: 3,
        consecutive: true,
        soakComplete: true,
      },
    });
  });

  it("can become READY while all verified awards remain atomically private", () => {
    const input = readyInput();
    input.registry = input.registry.map((row) => ({ ...row, release_epoch: null }));
    input.effectivePublication = input.effectivePublication.map((row) => ({
      ...row,
      effectively_verified: false,
      effective_reason: "cohort_release_pending",
      release_epoch: null,
      release_state: "pending",
    }));

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("READY");
    expect(summary.visibleCount).toBe(0);
    expect(summary.release.atomic).toBe(false);
    expect(summary.awards.every((award) => award.cohortReady)).toBe(true);
  });

  it("fails closed to UNKNOWN when any required load reports an error", () => {
    const input = readyInput();
    input.loadErrors = ["Stage 1 source manifests: connection unavailable"];
    input.effectivePublication[0].effectively_verified = false;

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("UNKNOWN");
    expect(summary.unknownReasons).toContain("Stage 1 source manifests: connection unavailable");
    expect(summary.blockers.length).toBeGreaterThan(0);
  });

  it("returns HOLD for a known publication blocker", () => {
    const input = readyInput();
    input.effectivePublication[0] = {
      ...input.effectivePublication[0],
      effectively_verified: false,
      effective_reason: "actionable_quarantine_open",
    };
    input.quarantineCountsByCohort[stage1CohortIdentity[0][1]] = 2;

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    expect(summary.visibleCount).toBe(24);
    expect(summary.release.atomic).toBe(false);
    expect(summary.blockers.join(" ")).toContain("partial (24/25)");
    expect(summary.awards[0].quarantineCount).toBe(2);
    expect(summary.safeNextAction).toContain("Keep release on hold");
  });

  it("always renders exactly 25 truthful award positions when registry rows are missing", () => {
    const input = readyInput();
    input.registry = input.registry.slice(0, 23);
    input.manifests = input.manifests.filter((manifest) =>
      !stage1CohortIdentity.slice(23).some((identity) => identity[1] === manifest.cohort_key));
    input.effectivePublication = input.effectivePublication.slice(0, 23);

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    expect(summary.awards).toHaveLength(25);
    expect(summary.awards[23].canonicalName).toBe("Missing Stage 1 award #24");
    expect(summary.awards[24].effectiveReason).toContain("No registry row");
  });

  it("holds when either paid review lane does not have the fixed $5 daily cap", () => {
    const input = readyInput();
    input.budgets[1] = { ...input.budgets[1], capUsd: 15, remainingUsd: 15 };

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    expect(summary.budgets[1].status).toBe("hold");
    expect(summary.blockers.join(" ")).toContain("daily cap is not $5");
  });

  it("holds on any unresolved advisor-invite security reissue", () => {
    const input = readyInput();
    input.inviteSecurityReissues = {
      count: 2,
      oldestAt: "2026-07-14T12:00:00.000Z",
    };

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    expect(summary.inviteSecurityReissues).toMatchObject({
      status: "hold",
      count: 2,
      oldestAt: "2026-07-14T12:00:00.000Z",
    });
    expect(summary.blockers.join(" ")).toContain("2 advisor invitations");
  });

  it("holds when the latest 6 PM triad lacks one authoritative inventory proof", () => {
    const input = readyInput();
    if (!input.visualNightly) throw new Error("Ready fixture requires a nightly report.");
    input.visualNightly.inventoryProofComplete = false;
    input.visualNightly.inventoryComplete = false;
    input.visualNightly.summary = "The global source inventory hashes did not agree.";

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    expect(summary.nightly.status).toBe("hold");
    expect(summary.blockers).toContain("The global source inventory hashes did not agree.");
  });

  it("holds until three exact normal scheduled 6 PM cohorts are available", () => {
    const input = readyInput();
    input.visualWorkerRuns = input.visualWorkerRuns.filter((run) =>
      !run.id.startsWith("worker-2026-07-13-") &&
      !run.id.startsWith("worker-2026-07-14-"));

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    expect(summary.nightly.acceptance).toMatchObject({
      observedCohorts: 2,
      healthyCohorts: 2,
      consecutive: false,
      soakComplete: false,
    });
    expect(summary.nightly.detail).toContain("Only 2/3");
  });

  it("does not count targeted or repair runs toward 6 PM acceptance", () => {
    const input = readyInput();
    input.visualWorkerRuns = input.visualWorkerRuns.map((run) => {
      if (
        !run.id.startsWith("worker-2026-07-13-") &&
        !run.id.startsWith("worker-2026-07-14-")
      ) return run;
      const metadata = run.metadata as Record<string, unknown>;
      return {
        ...run,
        metadata: {
          ...metadata,
          options: {
            ...(metadata.options as Record<string, unknown>),
            localization_repair: true,
            source_id: `target-${run.id}`,
          },
        },
      };
    });

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    expect(summary.nightly.acceptance.observedCohorts).toBe(2);
    expect(summary.nightly.detail).toContain("repair and targeted runs do not count");
  });

  it("holds when the three latest exact cohorts are not consecutive", () => {
    const input = readyInput();
    input.visualWorkerRuns = input.visualWorkerRuns.filter((run) =>
      !run.id.startsWith("worker-2026-07-15-"));

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    expect(summary.nightly.acceptance).toMatchObject({
      observedCohorts: 3,
      healthyCohorts: 3,
      consecutive: false,
    });
    expect(summary.nightly.detail).toContain("not on consecutive monitoring dates");
  });

  it("holds when a historical acceptance cohort fails exact inventory proof", () => {
    const input = readyInput();
    input.visualWorkerRuns = input.visualWorkerRuns.map((run) => {
      if (run.id !== "worker-2026-07-15-3") return run;
      const metadata = run.metadata as Record<string, unknown>;
      return {
        ...run,
        metadata: {
          ...metadata,
          source_inventory: {
            ...(metadata.source_inventory as Record<string, unknown>),
            proof_complete: false,
          },
        },
      };
    });

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    expect(summary.nightly.acceptance.healthyCohorts).toBe(2);
    expect(summary.nightly.detail).toContain("2026-07-15 did not pass exact-inventory acceptance");
  });

  it("holds until the 24-hour acceptance soak has elapsed", () => {
    const input = readyInput();
    input.visualWorkerRuns = input.visualWorkerRuns.filter((run) =>
      !run.id.startsWith("worker-2026-07-13-"));

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    expect(summary.nightly.acceptance.soakComplete).toBe(false);
    expect(summary.nightly.detail).toContain("24-hour soak is still in progress");
  });

  it("does not count future-dated worker runs toward nightly acceptance", () => {
    const input = readyInput();
    input.visualWorkerRuns.push(...[1, 2, 3].map((shard) => workerRun(shard, "2026-07-18")));

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("READY");
    expect(summary.nightly.acceptance.cohorts[0]?.monitoringDate).toBe("2026-07-16");
  });

  it("fails to UNKNOWN when any of the exact eight downstream lanes is missing", () => {
    const input = readyInput();
    input.lanes = input.lanes.filter((lane) => lane.laneKey !== "page_audit");

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("UNKNOWN");
    expect(summary.lanes).toHaveLength(8);
    expect(summary.lanes.find((lane) => lane.laneKey === "page_audit")?.status).toBe("unknown");
    expect(summary.unknownReasons.join(" ")).toContain("exactly these eight keys");
  });

  it("holds when any immutable release proof artifact is missing", () => {
    const input = readyInput();
    delete input.releaseArtifacts.non_cohort_leak_crawl;

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    expect(summary.acceptanceArtifacts.find((artifact) =>
      artifact.kind === "non_cohort_leak_crawl")?.status).toBe("hold");
    expect(summary.blockers.join(" ")).toContain("no retained release-bound proof artifact");
  });

  it("holds when a current R2 recovery shard reports a refused restore", () => {
    const input = readyInput();
    input.evidenceRecovery = {
      ...input.evidenceRecovery,
      refused: 1,
      statusReason: "One immutable hash mismatch was refused.",
    };

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    expect(summary.recovery.status).toBe("hold");
  });

  it("holds on disabled, wrongly billed, expired, or SLA-breached lanes", () => {
    const input = readyInput();
    input.lanes = input.lanes.map((lane) => {
      if (lane.laneKey === "reconciliation") return { ...lane, enabled: false };
      if (lane.laneKey === "suppression") return { ...lane, paid: true };
      if (lane.laneKey === "page_audit") return { ...lane, slaBreached: true };
      if (lane.laneKey === "manual_quarantine") {
        return {
          ...lane,
          lastStatus: "claimed",
          leaseExpiresAt: "2026-07-16T17:00:00.000Z",
        };
      }
      return lane;
    });

    const summary = summarizeStage1BetaReleaseGate(input);

    expect(summary.state).toBe("HOLD");
    for (const laneKey of ["reconciliation", "suppression", "page_audit", "manual_quarantine"]) {
      expect(summary.lanes.find((lane) => lane.laneKey === laneKey)?.status).toBe("hold");
    }
  });
});

function readyInput(): Stage1ReleaseGateInput {
  const registry = Array.from({ length: 25 }, (_, index) => registryRow(index + 1));
  const manifests = registry.flatMap((award) => manifestRows(award.cohort_key));
  const latestReconciliations = Object.fromEntries(
    registry.map((award) => [award.canonical_shared_award_id, reconciliationRow(award.canonical_shared_award_id)]),
  );
  const latestAudits = Object.fromEntries(
    registry.map((award) => [award.canonical_shared_award_id, auditRow(award.canonical_shared_award_id)]),
  );
  const visualWorkerRuns = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"].flatMap(
    (monitoringDate) => Array.from(
      { length: 3 },
      (_, index) => workerRun(index + 1, monitoringDate),
    ),
  );
  const visualNightly = buildVisualNightlyReport(visualWorkerRuns, new Date(now));
  if (!visualNightly) throw new Error("Ready fixture requires a nightly report.");
  return {
    now,
    registry,
    manifests,
    effectivePublication: registry.map((award) => ({
      cohort_key: award.cohort_key,
      effectively_verified: true,
      effective_reason: "verified",
      evaluated_at: now,
      cohort_ready: true,
      cohort_readiness_reason: "verified",
      release_epoch: "11111111-1111-4111-8111-111111111111",
      release_state: "verified_beta",
      release_policy_version: "stage1-publication-v1",
      release_identity_version: stage1CohortIdentityVersion,
      release_identity_hash: stage1CohortIdentityHash,
    })),
    latestReconciliations,
    latestAudits,
    quarantineCountsByCohort: Object.fromEntries(registry.map((award) => [award.cohort_key, 0])),
    inviteReadiness: {
      ready: true,
      status: "ready",
      disableSignup: true,
      reason: "Hosted Supabase Auth reports disable_signup=true.",
    },
    inviteSecurityReissues: {
      count: 0,
      oldestAt: null,
    },
    appIdentity: {
      revision: "revision-a",
      policy_hash: "policy-a",
      batch_policy_hash: "batch-a",
      suppression_policy_hash: "suppression-a",
      matcher_hash: "matcher-a",
    },
    migrationIdentity: {
      status: "match",
      reason: "Required database contracts are reachable.",
    },
    visualNightly,
    visualWorkerRuns,
    budgets: budgetRows(),
    lanes: downstreamLaneRows(),
    evidenceRecovery: recoveryEvidence(),
    releaseArtifacts: releaseArtifactRows(),
    loadErrors: [],
  };
}

function recoveryEvidence() {
  return {
    enabled: true,
    expectedShards: 3,
    reportingShards: 3,
    missingShardNumbers: [],
    disabledShardNumbers: [],
    unknownShardNumbers: [],
    attempts: 1,
    recovered: 1,
    exactGeometryRecovered: 1,
    evidenceOnlyRecovered: 0,
    refused: 0,
    failed: 0,
    reasons: [],
    statusReason: "All three scheduled shards reported R2 recovery enabled.",
    safeAction: "No action required.",
    lastReportedAt: "2026-07-16T23:30:00.000Z",
    configurationSource: "Immutable R2 generation + current scheduled cohort",
  };
}

function releaseArtifactRows(): Stage1ReleaseGateInput["releaseArtifacts"] {
  const shared = {
    environment: "production-candidate",
    status: "passed" as const,
    cohort_identity_version: stage1CohortIdentityVersion,
    cohort_identity_hash: stage1CohortIdentityHash,
    policy_version: "stage1-publication-v1",
    app_revision: "revision-a",
    evidence_hash: "a".repeat(64),
    started_at: "2026-07-17T10:00:00.000Z",
    completed_at: "2026-07-17T11:00:00.000Z",
    valid_until: "2026-07-18T11:00:00.000Z",
    actor: "release-operator@example.edu",
  };
  return {
    rollback_drill: {
      ...shared,
      id: "artifact-rollback",
      artifact_kind: "rollback_drill",
      evidence: {
        rollback_succeeded: true,
        restore_succeeded: true,
        before_state_hash: "before",
        rollback_state_hash: "rollback",
        restored_state_hash: "restored",
      },
    },
    non_cohort_leak_crawl: {
      ...shared,
      id: "artifact-leak",
      artifact_kind: "non_cohort_leak_crawl",
      evidence: {
        anonymous: true,
        routes_checked: 100,
        non_cohort_leaks: 0,
        unexpected_stage1_leaks: 0,
        base_url: "https://awardping.example",
      },
    },
    r2_recovery_drill: {
      ...shared,
      id: "artifact-r2",
      artifact_kind: "r2_recovery_drill",
      evidence: {
        hash_verified: true,
        recovered_objects: 1,
        failed_objects: 0,
        refused_objects: 0,
      },
    },
    visual_crop_coverage: {
      ...shared,
      id: "artifact-crops",
      artifact_kind: "visual_crop_coverage",
      evidence: {
        eligible_events: 10,
        unverified_publishable_events: 0,
        terminal_failures: 0,
        r2_hashes_verified: true,
        coverage_set_hash: "b".repeat(64),
      },
    },
  };
}

function registryRow(rank: number): RegistryRow {
  const identity = stage1CohortIdentity[rank - 1];
  return {
    cohort_key: identity[1],
    launch_rank: rank,
    canonical_name: identity[2],
    canonical_shared_award_id: identity[3],
    canonical_slug: identity[4],
    official_homepage: identity[5],
    publication_state: "verified_beta",
    state_reason: "Verified for beta",
    policy_version: "stage1-publication-v1",
    fact_ledger_batch_id: `batch-${rank}`,
    release_epoch: "11111111-1111-4111-8111-111111111111",
    evidence_checked_at: "2026-07-16T17:30:00.000Z",
    last_verified_at: "2026-07-16T17:30:00.000Z",
    created_at: "2026-07-16T17:00:00.000Z",
    updated_at: "2026-07-16T17:30:00.000Z",
  };
}

function manifestRows(cohortKey: string): ManifestRow[] {
  return stage1ReleaseManifestRoles.map((sourceRole) => ({
    cohort_key: cohortKey,
    source_role: sourceRole,
    manifest_status: "present",
    source_ids: [`source-${cohortKey}-${sourceRole}`],
    evidence: {
      official: true,
      source_url: `https://example.org/${cohortKey}/${sourceRole}`,
      supporting_text: "Official source confirms this role.",
      source_bindings: { source: { hashes: { sha256: "hash" } } },
      fact_candidate_ids: [`candidate-${cohortKey}-${sourceRole}`],
      captured_at: "2026-07-16T17:30:00.000Z",
      r2_verified_at: "2026-07-16T17:30:00.000Z",
      local_verified_at: "2026-07-16T17:30:00.000Z",
      cycle: "2027",
      reconciliation_status: "passed",
      policy_version: "stage1-publication-v1",
    },
    checked_at: "2026-07-16T17:30:00.000Z",
    policy_version: "stage1-publication-v1",
    created_at: "2026-07-16T17:00:00.000Z",
    updated_at: "2026-07-16T17:30:00.000Z",
  }));
}

function reconciliationRow(sharedAwardId: string) {
  return {
    id: `reconciliation-${sharedAwardId}`,
    shared_award_id: sharedAwardId,
    reason: "Stage 1 verification",
    source_ids: [],
    candidate_ids: [],
    status: "succeeded" as const,
    priority: 10,
    created_at: "2026-07-16T17:00:00.000Z",
    started_at: "2026-07-16T17:10:00.000Z",
    completed_at: "2026-07-16T17:30:00.000Z",
    error: null,
    metadata: {},
    generation: 1,
  };
}

function auditRow(sharedAwardId: string) {
  return {
    id: `audit-${sharedAwardId}`,
    shared_award_id: sharedAwardId,
    audit_kind: "deterministic" as const,
    audit_status: "passed" as const,
    severity: "info" as const,
    findings: [],
    suggested_fixes: [],
    field_conflicts: [],
    source_rejections: [],
    selected_fact_summary: {},
    public_page_snapshot: {},
    model: null,
    gemini_batch_name: null,
    gemini_batch_request_key: null,
    ai_result: {},
    created_at: "2026-07-16T17:30:00.000Z",
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
  };
}

function workerRun(shardNumber: number, monitoringDate: string): WorkerRun {
  const shardIndex = shardNumber - 1;
  const sources = Array.from({ length: 300 }, (_, index) => ({
    id: `source-${index + 1}`,
    shardIndex: index % 3,
  }));
  const sourceInventory = buildVisualSourceInventoryProof({
    eligibleSources: sources,
    loadedSources: sources.filter((source) => source.shardIndex === shardIndex),
    shardCount: 3,
    shardIndex,
    shardIndexForSource: (source) => Number(source.shardIndex),
    capturedAt: `${monitoringDate}T23:00:00.000Z`,
  });
  return {
    id: `worker-${monitoringDate}-${shardNumber}`,
    worker_name: `local-visual-snapshot-worker-shard-${shardNumber}-of-3`,
    status: "succeeded",
    ai_provider: "gemini",
    checked_count: 100,
    changed_count: 0,
    unchanged_count: 100,
    initial_count: 0,
    discovered_count: 0,
    failed_count: 0,
    error: null,
    metadata: {
      kind: "visual_snapshot",
      worker_revision: "revision-a",
      monitoring_policy_bundle: { hash: "policy-a" },
      monitoring_policy: { hash: "batch-a" },
      suppression_policy: { hash: "suppression-a" },
      matcher_digest: "matcher-a",
      run_identity: {
        workflow: "visual_capture",
        trigger: "scheduled",
        cohort_id: `visual-nightly:${monitoringDate}`,
        monitoring_date: monitoringDate,
        timezone: "America/Chicago",
        shard_count: 3,
        shard_index: shardIndex,
      },
      options: {
        limit: 50_000,
        shard_count: 3,
        shard_index: shardIndex,
        run_trigger: "scheduled",
        run_cohort_id: `visual-nightly:${monitoringDate}`,
        include_not_due: true,
        source_id: null,
        source_ids_filter_count: 0,
        localization_repair: false,
        baseline_refresh: false,
        discovery_mode: true,
        discovery_intent: "live_recurring",
        discovery_onboarding_batch_id: null,
      },
      baseline_coverage: { start: { loaded_sources: 100 } },
      source_inventory: sourceInventory,
    },
    started_at: `${monitoringDate}T23:00:0${shardIndex}.000Z`,
    finished_at: `${monitoringDate}T23:30:0${shardIndex}.000Z`,
  };
}

function budgetRows(): AdminGeminiBudgetLane[] {
  return ["new_page_review", "changed_page_review"].map((laneKey) => ({
    laneKey,
    label: laneKey === "new_page_review" ? "New page review" : "Changed page review",
    capUsd: 5,
    reservedUsd: 1,
    spentUsd: 2,
    remainingUsd: 2,
    resetAt: "2026-07-17T00:00:00.000Z",
    configurationSource: "Database policy",
  }));
}

function downstreamLaneRows(): AdminDownstreamLane[] {
  return [
    "new_page_review",
    "changed_page_review",
    "feedback_promotion",
    "suppression",
    "reconciliation",
    "page_audit",
    "manual_quarantine",
    "nightly_report",
  ].map((laneKey) => ({
    laneKey,
    label: laneKey.replaceAll("_", " "),
    paid: laneKey === "new_page_review" || laneKey === "changed_page_review",
    enabled: true,
    claimable: false,
    timeoutSeconds: 900,
    leaseTtlSeconds: 900,
    oldestItemSlaSeconds: 3_600,
    queueDepth: 0,
    oldestItemAt: null,
    nextSlaDueAt: null,
    slaBreached: false,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseExpired: false,
    nextRetryAt: null,
    consecutiveFailures: 0,
    lastStatus: "succeeded",
    lastError: null,
    lastStartedAt: "2026-07-16T17:00:00.000Z",
    lastFinishedAt: "2026-07-16T17:05:00.000Z",
    lastSucceededAt: "2026-07-16T17:05:00.000Z",
    lastFailedAt: null,
    policySource: "postgres_lane_scheduler_v1",
  }));
}
