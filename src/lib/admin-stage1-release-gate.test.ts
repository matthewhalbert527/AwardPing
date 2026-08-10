import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/invite-only-signup-readiness", () => ({
  checkInviteOnlySignupReleaseReadiness: vi.fn(async () => ({
    ready: false,
    status: "unknown",
    disableSignup: null,
    reason: "Test fixture.",
  })),
}));

import { loadAdminStage1ReleaseGateEvidence } from "@/lib/admin-stage1-release-gate";
import {
  stage1ReleaseArtifactKinds,
  type Stage1ReleaseArtifact,
  type Stage1ReleaseArtifactKind,
} from "@/lib/stage1-release-gate-summary";

describe("admin Stage 1 release-gate evidence loader", () => {
  it("loads only exact current-valid bindings when hosted-runtime history exceeds 40 rows", async () => {
    const hostedRows = Array.from({ length: 45 }, (_, index) =>
      artifact(
        "hosted_runtime_identity",
        uuid(index + 1),
        new Date(Date.UTC(2026, 7, 10, 12, index)).toISOString(),
        hash(index + 1),
      ));
    const otherRows = stage1ReleaseArtifactKinds
      .filter((kind) => kind !== "hosted_runtime_identity")
      .map((kind, index) => artifact(
        kind,
        uuid(index + 101),
        new Date(Date.UTC(2026, 7, 9, 12, index)).toISOString(),
        hash(index + 101),
      ));
    const authoritativeRows = [hostedRows[7], ...otherRows];
    const { admin, artifactQueries, rpc } = buildAdmin(
      [...hostedRows, ...otherRows],
      { gateSnapshot: releaseGateSnapshot(authoritativeRows) },
    );

    const evidence = await loadAdminStage1ReleaseGateEvidence(admin);

    expect(Object.keys(evidence.releaseArtifacts).sort()).toEqual(
      [...stage1ReleaseArtifactKinds].sort(),
    );
    expect(evidence.releaseArtifacts.hosted_runtime_identity?.id).toBe(hostedRows[7].id);
    for (const row of authoritativeRows) {
      expect(evidence.releaseArtifacts[row.artifact_kind]?.id).toBe(row.id);
    }
    expect(artifactQueries).toHaveLength(stage1ReleaseArtifactKinds.length);
    expect(artifactQueries.map((query) => query.equalities.artifact_kind).sort()).toEqual(
      [...stage1ReleaseArtifactKinds].sort(),
    );
    expect(artifactQueries.every((query) => query.rowLimit === 1)).toBe(true);
    expect(artifactQueries.every((query) =>
      typeof query.equalities.id === "string" &&
      typeof query.equalities.evidence_hash === "string")).toBe(true);
    expect(rpc).toHaveBeenCalledWith("get_stage1_release_gate_snapshot");
    expect(evidence.authoritativeGate?.vaultSecurity).toMatchObject({
      apiSurfaceSafe: true,
      serviceRoleDataApiProfileBlocked: true,
    });
    expect(evidence.loadErrors).toEqual([]);
  });

  it("fails closed for a per-kind artifact query error without discarding other kinds", async () => {
    const rows = stage1ReleaseArtifactKinds.map((kind, index) => artifact(
      kind,
      uuid(index + 201),
      new Date(Date.UTC(2026, 7, 10, 12, index)).toISOString(),
      hash(index + 201),
    ));
    const { admin } = buildAdmin(rows, {
      errorsByKind: {
        rollback_drill: { message: "artifact partition unavailable" },
      },
    });

    const evidence = await loadAdminStage1ReleaseGateEvidence(admin);

    expect(evidence.releaseArtifacts.rollback_drill).toBeUndefined();
    expect(evidence.releaseArtifacts.hosted_runtime_identity?.id).toBe(
      rows[0].id,
    );
    expect(evidence.loadErrors).toEqual([
      "Stage 1 release acceptance artifact (rollback_drill): artifact partition unavailable",
    ]);
  });

  it("does not fall back to retained history when an authoritative ID was revoked", async () => {
    const rows = stage1ReleaseArtifactKinds.map((kind, index) => artifact(
      kind,
      uuid(index + 301),
      "2026-08-10T12:00:00.000Z",
      hash(index + 301),
    ));
    const snapshot = releaseGateSnapshot(rows);
    snapshot.artifacts.hosted_runtime_identity = { id: null, evidence_hash: null };
    const { admin, artifactQueries } = buildAdmin(rows, { gateSnapshot: snapshot });

    const evidence = await loadAdminStage1ReleaseGateEvidence(admin);

    expect(evidence.releaseArtifacts.hosted_runtime_identity).toBeUndefined();
    expect(evidence.authoritativeGate?.artifactBindings.hosted_runtime_identity).toEqual({
      artifactId: null,
      evidenceHash: null,
    });
    expect(artifactQueries).toHaveLength(stage1ReleaseArtifactKinds.length - 1);
    expect(evidence.loadErrors).toEqual([]);
  });

  it("fails closed when an authoritative artifact ID no longer resolves", async () => {
    const rows = stage1ReleaseArtifactKinds.map((kind, index) => artifact(
      kind,
      uuid(index + 401),
      "2026-08-10T12:00:00.000Z",
      hash(index + 401),
    ));
    const snapshot = releaseGateSnapshot(rows);
    snapshot.artifacts.rollback_drill.id = uuid(999);
    const { admin } = buildAdmin(rows, { gateSnapshot: snapshot });

    const evidence = await loadAdminStage1ReleaseGateEvidence(admin);

    expect(evidence.releaseArtifacts.rollback_drill).toBeUndefined();
    expect((evidence.loadErrors || []).join(" ")).toContain(
      "authoritative ID 00000000-0000-4000-8000-000000000999",
    );
  });

  it("fails closed when the retained evidence hash differs from the authoritative binding", async () => {
    const rows = stage1ReleaseArtifactKinds.map((kind, index) => artifact(
      kind,
      uuid(index + 501),
      "2026-08-10T12:00:00.000Z",
      hash(index + 501),
    ));
    const snapshot = releaseGateSnapshot(rows);
    snapshot.artifacts.r2_recovery_drill.evidence_hash = "f".repeat(64);
    const { admin } = buildAdmin(rows, { gateSnapshot: snapshot });

    const evidence = await loadAdminStage1ReleaseGateEvidence(admin);

    expect(evidence.releaseArtifacts.r2_recovery_drill).toBeUndefined();
    expect((evidence.loadErrors || []).join(" ")).toContain(
      "authoritative ID 00000000-0000-4000-8000-000000000504 and evidence hash do not resolve",
    );
  });

  it("rejects a gate snapshot with missing Vault authority", async () => {
    const rows = stage1ReleaseArtifactKinds.map((kind, index) => artifact(
      kind,
      uuid(index + 601),
      "2026-08-10T12:00:00.000Z",
      hash(index + 601),
    ));
    const snapshot = releaseGateSnapshot(rows) as Record<string, unknown>;
    delete snapshot.vault_security;
    const { admin, artifactQueries } = buildAdmin(rows, { gateSnapshot: snapshot });

    const evidence = await loadAdminStage1ReleaseGateEvidence(admin);

    expect(evidence.authoritativeGate).toBeNull();
    expect(evidence.releaseArtifacts).toEqual({});
    expect(artifactQueries).toHaveLength(0);
    expect((evidence.loadErrors || []).join(" ")).toContain(
      "Vault security booleans are missing or invalid",
    );
  });

  it("retains explicit unsafe Vault authority for the summary to block", async () => {
    const rows = stage1ReleaseArtifactKinds.map((kind, index) => artifact(
      kind,
      uuid(index + 701),
      "2026-08-10T12:00:00.000Z",
      hash(index + 701),
    ));
    const snapshot = releaseGateSnapshot(rows);
    snapshot.vault_security.api_surface_safe = false;
    const { admin } = buildAdmin(rows, { gateSnapshot: snapshot });

    const evidence = await loadAdminStage1ReleaseGateEvidence(admin);

    expect(evidence.authoritativeGate?.vaultSecurity.apiSurfaceSafe).toBe(false);
    expect(Object.keys(evidence.releaseArtifacts)).toHaveLength(5);
    expect(evidence.loadErrors).toEqual([]);
  });
});

function artifact(
  kind: Stage1ReleaseArtifactKind,
  id: string,
  completedAt: string,
  evidenceHash: string,
): Stage1ReleaseArtifact {
  return {
    id,
    artifact_kind: kind,
    environment: "production",
    status: "passed",
    cohort_identity_version: "stage1-national-25-v1",
    cohort_identity_hash: "test-cohort-hash",
    policy_version: "stage1-publication-v1",
    app_revision: "test-revision",
    evidence: {},
    evidence_hash: evidenceHash,
    started_at: new Date(Date.parse(completedAt) - 60_000).toISOString(),
    completed_at: completedAt,
    valid_until: "2026-08-11T12:00:00.000Z",
    actor: "test-suite",
  };
}

type GateSnapshot = ReturnType<typeof releaseGateSnapshot>;

function releaseGateSnapshot(rows: Stage1ReleaseArtifact[]) {
  return {
    schema_version: "stage1-release-gate-acceptance-v2",
    state: "READY" as const,
    state_hash: "a".repeat(64),
    generated_at: "2026-08-10T12:00:00.000Z",
    failures: [] as string[],
    production_target: { configured: true },
    vault_security: {
      api_surface_safe: true,
      service_role_data_api_profile_blocked: true,
      profile_http_status: 406,
      profile_postgrest_code: "PGRST106",
    },
    artifacts: Object.fromEntries(stage1ReleaseArtifactKinds.map((kind) => {
      const row = rows.find((candidate) => candidate.artifact_kind === kind);
      return [kind, {
        id: row?.id || null,
        evidence_hash: row?.evidence_hash || null,
      }];
    })) as Record<Stage1ReleaseArtifactKind, {
      id: string | null;
      evidence_hash: string | null;
    }>,
  };
}

function uuid(value: number) {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function hash(value: number) {
  return value.toString(16).padStart(64, "0").slice(-64);
}

function buildAdmin(
  artifacts: Stage1ReleaseArtifact[],
  options: {
    errorsByKind?: Partial<Record<Stage1ReleaseArtifactKind, { message: string }>>;
    gateSnapshot?: GateSnapshot | Record<string, unknown>;
  } = {},
) {
  const errorsByKind = options.errorsByKind || {};
  const gateSnapshot = options.gateSnapshot || releaseGateSnapshot(artifacts);
  const artifactQueries: ArtifactQuery[] = [];
  const from = vi.fn((table: string): unknown => {
    if (table === "stage1_release_acceptance_artifacts") {
      const query = new ArtifactQuery(artifacts, errorsByKind);
      artifactQueries.push(query);
      return query;
    }
    if (
      table === "stage1_award_registry" ||
      table === "stage1_award_members" ||
      table === "stage1_award_source_manifest"
    ) {
      return new ArrayQuery([]);
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });
  const rpc = vi.fn(async (name: string) => {
    if (name === "get_stage1_release_gate_snapshot") {
      return { data: gateSnapshot, error: null };
    }
    if (name === "list_stage1_effective_publication") {
      return { data: [], error: null };
    }
    if (name === "get_office_invite_security_reissue_status") {
      return {
        data: {
          unresolved_count: 0,
          oldest_rotated_at: null,
          evaluated_at: "2026-08-10T12:00:00.000Z",
        },
        error: null,
      };
    }
    if (
      name === "get_stage1_publication_snapshot" ||
      name === "get_awardping_release_contract_status"
    ) {
      return { data: null, error: null };
    }
    throw new Error(`Unexpected RPC in test: ${name}`);
  });
  return {
    admin: { from, rpc } as unknown as Parameters<
      typeof loadAdminStage1ReleaseGateEvidence
    >[0],
    artifactQueries,
    rpc,
  };
}

type QueryError = { message: string };
type ArtifactQueryResult = {
  data: Stage1ReleaseArtifact[] | null;
  error: QueryError | null;
};

class ArtifactQuery implements PromiseLike<ArtifactQueryResult> {
  readonly equalities: Partial<Record<keyof Stage1ReleaseArtifact, unknown>> = {};
  rowLimit: number | null = null;

  constructor(
    private readonly rows: Stage1ReleaseArtifact[],
    private readonly errorsByKind: Partial<
      Record<Stage1ReleaseArtifactKind, QueryError>
    >,
  ) {}

  select() {
    return this;
  }

  eq(column: keyof Stage1ReleaseArtifact, value: unknown) {
    this.equalities[column] = value;
    return this;
  }

  limit(value: number) {
    this.rowLimit = value;
    return this;
  }

  async maybeSingle() {
    const result = this.resolve();
    return {
      data: result.error ? null : result.data?.[0] || null,
      error: result.error,
    };
  }

  then<TResult1 = ArtifactQueryResult, TResult2 = never>(
    onfulfilled?: ((value: ArtifactQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }

  private resolve(): ArtifactQueryResult {
    const requestedKind = this.equalities.artifact_kind as
      | Stage1ReleaseArtifactKind
      | undefined;
    const failedKind = requestedKind && this.errorsByKind[requestedKind]
      ? requestedKind
      : null;
    if (failedKind) {
      return { data: null, error: this.errorsByKind[failedKind] || null };
    }
    const rows = this.rows.filter((row) =>
      Object.entries(this.equalities).every(([column, expected]) =>
        row[column as keyof Stage1ReleaseArtifact] === expected));
    return {
      data: this.rowLimit === null ? rows : rows.slice(0, this.rowLimit),
      error: null,
    };
  }
}

type ArrayQueryResult = { data: unknown[]; error: null };

class ArrayQuery implements PromiseLike<ArrayQueryResult> {
  constructor(private readonly rows: unknown[]) {}

  select() {
    return this;
  }

  order() {
    return this;
  }

  then<TResult1 = ArrayQueryResult, TResult2 = never>(
    onfulfilled?: ((value: ArrayQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve<ArrayQueryResult>({ data: this.rows, error: null }).then(
      onfulfilled,
      onrejected,
    );
  }
}
