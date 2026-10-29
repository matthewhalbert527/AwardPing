import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: vi.fn(),
}));

import {
  buildStage1PublicationIndex,
  loadStage1PublicationIndex,
  isStage1SourceIdentityExcluded,
  isEffectivelyVerifiedRegistryRow,
  stage1AwardCount,
  stage1PublicationPolicyVersion,
  type Stage1SourceIdentityRule,
  type Stage1EffectivePublicationRow,
  type Stage1MemberRow,
  type Stage1RegistryRow,
} from "@/lib/stage1-publication";
import { stage1CohortIdentity } from "@/lib/stage1-cohort-identity";
import {
  stage1CohortIdentityHash,
  stage1CohortIdentityVersion,
} from "@/lib/stage1-cohort-identity";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import textMonitoring from "../../config/program-text-monitoring.json";

const now = new Date("2026-07-16T20:00:00.000Z");
const releaseEpoch = "11111111-1111-4111-8111-111111111111";

describe("Stage 1 publication gate", () => {
  it("loads identity, basic snapshots and alert authority without retired full-fact or manual-route RPCs", async () => {
    const fixture = activatedCohortFixture();
    const snapshot = { schema_version: 3, cohort_identity_version: stage1CohortIdentityVersion, cohort_identity_hash: stage1CohortIdentityHash,
      evaluated_at: now.toISOString(), release: { release_key: "stage1-national-25", release_state: "verified_beta", release_epoch: releaseEpoch,
        policy_version: stage1PublicationPolicyVersion, cohort_identity_version: stage1CohortIdentityVersion, cohort_identity_hash: stage1CohortIdentityHash,
        activated_at: fixture.release.activatedAt, effectively_released: true, effective_reason: "verified", ready_cohort_count: 25 },
      cohorts: fixture.registryRows.map((registry, n) => { const sourceId = `70000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`;
        return { registry: { ...registry, fact_ledger_batch_id: registry.fact_ledger_batch_id ?? null }, effectively_verified: true, effective_reason: "verified", cohort_ready: true,
          cohort_readiness_reason: "verified", evaluated_at: now.toISOString(), members: fixture.memberRows.filter(row => row.cohort_key === registry.cohort_key),
          identity_rules: [], allowed_source_ids: [sourceId], reviewed_homepage: { source_id: sourceId, url: registry.official_homepage },
          published_facts: { overview: `Accepted ${registry.canonical_name} overview.` } };
      }) };
    const rpc = vi.fn(async (name: string) => {
      if (name === "get_stage1_publication_snapshot") return { data: snapshot, error: null };
      if (name === "get_program_basic_facts") return { data: [], error: null };
      if (name === "get_program_text_public_alert_source_bindings") return { data: { schema: "awardping.program-text-public-alert-sources.v1", epoch: textMonitoring.epoch, source_count: 0, bindings: [] }, error: null };
      throw Error("Retired complete-fact and application-route workflows must not run here.");
    });
    vi.mocked(createSupabaseAdminClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createSupabaseAdminClient>);
    const index = await loadStage1PublicationIndex();
    expect(index.available).toBe(true); expect(index.verifiedEntries).toHaveLength(25);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["get_stage1_publication_snapshot", "get_program_basic_facts", "get_program_text_public_alert_source_bindings"]);
    expect(index.entries[0].publishedFacts).toEqual(snapshot.cohorts[0].published_facts);
  });
  it("publishes all 25 only under one fresh authoritative release epoch", () => {
    const fixture = activatedCohortFixture();
    fixture.memberRows.push(memberRow(1, "alias-1", "alias"));

    const index = buildStage1PublicationIndex({ ...fixture, now });

    expect(index.available).toBe(true);
    expect(index.verifiedCanonicalAwardIds).toHaveLength(stage1AwardCount);
    expect(index.verifiedMemberAwardIds).toContain("alias-1");
    expect(index.entryByMemberAwardId.get("alias-1")?.canonicalAwardId).toBe(
      stage1CohortIdentity[0][3],
    );
    expect(index.verifiedEntries.every((entry) => entry.effectivelyVerified)).toBe(true);
  });

  it("exposes zero awards when only one cohort is ready", () => {
    const fixture = cohortFixture();
    fixture.effectiveRows[0] = effectiveRow(1, false, "cohort_release_not_ready", {
      cohort_ready: true,
      cohort_readiness_reason: "verified",
    });

    const index = buildStage1PublicationIndex({ ...fixture, now });

    expect(index.available).toBe(true);
    expect(index.verifiedEntries).toEqual([]);
    expect(index.verifiedCanonicalAwardIds).toEqual([]);
  });

  it("fails closed on a partial effective result or mixed release epoch", () => {
    const partial = cohortFixture();
    partial.effectiveRows[0] = effectiveRow(1, true, "verified");
    expect(buildStage1PublicationIndex({ ...partial, now })).toMatchObject({
      available: false,
      verifiedCanonicalAwardIds: [],
    });

    const mixed = activatedCohortFixture();
    mixed.registryRows[4] = { ...mixed.registryRows[4], release_epoch: crypto.randomUUID() };
    const index = buildStage1PublicationIndex({ ...mixed, now });
    expect(index.available).toBe(false);
    expect(index.unavailableReason).toContain("mixed publication epoch");
  });

  it("fails closed when a reviewed homepage does not exactly match the registry", () => {
    const fixture = activatedCohortFixture();
    fixture.reviewedHomepageByCohortKey.set(stage1CohortIdentity[1][1], {
      sourceId: "source-2",
      url: "https://unreviewed.example/",
    });

    const index = buildStage1PublicationIndex({ ...fixture, now });

    expect(index.available).toBe(false);
    expect(index.unavailableReason).toContain("exact reviewed official-homepage");
  });

  it("keeps an immutable verification epoch durable but rejects missing, future, or wrong-policy evidence", () => {
    const fresh = registryRow(1, {
      publication_state: "verified_beta",
      evidence_checked_at: "2026-07-16T19:00:00.000Z",
      last_verified_at: "2026-07-16T19:30:00.000Z",
    });
    expect(isEffectivelyVerifiedRegistryRow(fresh, now)).toBe(true);
    expect(
      isEffectivelyVerifiedRegistryRow(
        { ...fresh, evidence_checked_at: "2026-07-15T19:59:59.000Z" },
        now,
      ),
    ).toBe(true);
    expect(
      isEffectivelyVerifiedRegistryRow(
        { ...fresh, last_verified_at: "2026-07-16T20:05:01.000Z" },
        now,
      ),
    ).toBe(false);
    expect(
      isEffectivelyVerifiedRegistryRow(
        { ...fresh, evidence_checked_at: null },
        now,
      ),
    ).toBe(false);
    expect(
      isEffectivelyVerifiedRegistryRow(
        { ...fresh, policy_version: "stage1-publication-v0" },
        now,
      ),
    ).toBe(false);
  });

  it("makes a malformed cohort entirely unavailable", () => {
    const fixture = cohortFixture();
    const { registryRows, memberRows } = fixture;
    expect(
      buildStage1PublicationIndex({
        ...fixture,
        registryRows: registryRows.slice(0, stage1AwardCount - 1),
        now,
      }),
    ).toMatchObject({
      available: false,
      verifiedCanonicalAwardIds: [],
      verifiedMemberAwardIds: [],
    });

    memberRows[0] = { ...memberRows[0], shared_award_id: "wrong-canonical" };
    expect(
      buildStage1PublicationIndex({
        ...fixture,
        registryRows,
        memberRows,
        now,
      }).available,
    ).toBe(false);
  });

  it("rejects one imported award assigned to two cohort entries", () => {
    const fixture = cohortFixture();
    const { memberRows } = fixture;
    memberRows.push(memberRow(2, stage1CohortIdentity[0][3], "alias"));

    const index = buildStage1PublicationIndex({
      ...fixture,
      memberRows,
      now,
    });
    expect(index.available).toBe(false);
    expect(index.unavailableReason).toContain("more than one cohort");
  });

  it("applies cohort-specific identity exclusions to sibling programs", () => {
    const fixture = cohortFixture();
    fixture.identityRules.push({
      id: 1,
      cohort_key: stage1CohortIdentity[0][1],
      rule_key: "exclude_sibling",
      url_pattern: "(?:^|/)sibling-program(?:/|$)",
      title_pattern: "sibling|postdoctoral|\\mmsf\\M",
      reason: "Separate program.",
      policy_version: stage1PublicationPolicyVersion,
      created_at: "2026-07-16T18:00:00.000Z",
      updated_at: "2026-07-16T18:00:00.000Z",
    });
    const index = buildStage1PublicationIndex({ ...fixture, now });
    const publication = index.entryByCohortKey.get(stage1CohortIdentity[0][1]);

    expect(publication).toBeDefined();
    expect(
      isStage1SourceIdentityExcluded(publication!, {
        url: "https://example.edu/apply/sibling-program/",
        title: "Application",
      }),
    ).toBe(true);
    expect(
      isStage1SourceIdentityExcluded(publication!, {
        url: "https://example.edu/apply/eligibility/",
        title: "Main scholarship eligibility",
      }),
    ).toBe(false);
  });

  it("rejects a silent substitution even when the registry still contains 25 rows", () => {
    const fixture = cohortFixture();
    fixture.registryRows[8] = {
      ...fixture.registryRows[8],
      canonical_name: "Substituted national award",
    };

    const index = buildStage1PublicationIndex({ ...fixture, now });

    expect(index.available).toBe(false);
    expect(index.unavailableReason).toContain("identity mismatch");
  });
});

function cohortFixture() {
  return {
    registryRows: Array.from({ length: stage1AwardCount }, (_, index) =>
      registryRow(index + 1),
    ),
    memberRows: Array.from({ length: stage1AwardCount }, (_, index) =>
      memberRow(index + 1, stage1CohortIdentity[index][3], "canonical"),
    ),
    identityRules: [] as Stage1SourceIdentityRule[],
    effectiveRows: Array.from({ length: stage1AwardCount }, (_, index) =>
      effectiveRow(index + 1, false, "state_pending"),
    ),
    release: {
      releaseKey: "stage1-national-25" as const,
      releaseState: "pending" as const,
      releaseEpoch: null,
      policyVersion: stage1PublicationPolicyVersion,
      cohortIdentityVersion: stage1CohortIdentityVersion,
      cohortIdentityHash: stage1CohortIdentityHash,
      activatedAt: null,
      effectivelyReleased: false,
      effectiveReason: "cohort_release_not_activated",
    },
    allowedSourceIdsByCohortKey: new Map(
      Array.from({ length: stage1AwardCount }, (_, index) => [
        stage1CohortIdentity[index][1],
        [`source-${index + 1}`],
      ]),
    ),
    publishedFactsByCohortKey: new Map(
      Array.from({ length: stage1AwardCount }, (_, index) => [
        stage1CohortIdentity[index][1],
        { overview: `Verified Award ${index + 1} overview.` },
      ]),
    ),
    reviewedHomepageByCohortKey: new Map<string, { sourceId: string; url: string }>(
      Array.from({ length: stage1AwardCount }, (_, index) => [
        stage1CohortIdentity[index][1],
        {
          sourceId: `source-${index + 1}`,
          url: stage1CohortIdentity[index][5],
        },
      ]),
    ),
  };
}

function activatedCohortFixture() {
  const fixture = cohortFixture();
  return {
    ...fixture,
    registryRows: fixture.registryRows.map((registry) => ({
      ...registry,
      publication_state: "verified_beta" as const,
      release_epoch: releaseEpoch,
      evidence_checked_at: "2026-07-16T19:00:00.000Z",
      last_verified_at: "2026-07-16T19:30:00.000Z",
    })),
    effectiveRows: fixture.effectiveRows.map((_, index) =>
      effectiveRow(index + 1, true, "verified", {
        cohort_ready: true,
        cohort_readiness_reason: "verified",
        release_epoch: releaseEpoch,
        release_state: "verified_beta",
      }),
    ),
    release: {
      ...fixture.release,
      releaseState: "verified_beta" as const,
      releaseEpoch,
      activatedAt: "2026-07-16T19:45:00.000Z",
      effectivelyReleased: true,
      effectiveReason: "verified",
    },
  };
}

function effectiveRow(
  cohort: number,
  effectivelyVerified: boolean,
  reason: string,
  overrides: Partial<Stage1EffectivePublicationRow> = {},
): Stage1EffectivePublicationRow {
  const base: Stage1EffectivePublicationRow = {
    cohort_key: stage1CohortIdentity[cohort - 1][1],
    effectively_verified: effectivelyVerified,
    effective_reason: reason,
    evaluated_at: now.toISOString(),
    cohort_ready: false,
    cohort_readiness_reason: reason,
    release_epoch: null,
    release_state: "pending" as const,
    release_policy_version: stage1PublicationPolicyVersion,
    release_identity_version: stage1CohortIdentityVersion,
    release_identity_hash: stage1CohortIdentityHash,
  };
  return { ...base, ...overrides };
}

function registryRow(
  rank: number,
  overrides: Partial<Stage1RegistryRow> = {},
): Stage1RegistryRow {
  const identity = stage1CohortIdentity[rank - 1];
  return {
    cohort_key: identity[1],
    launch_rank: rank,
    canonical_name: identity[2],
    canonical_shared_award_id: identity[3],
    canonical_slug: identity[4],
    official_homepage: identity[5],
    publication_state: "pending",
    state_reason: "Awaiting verification.",
    policy_version: stage1PublicationPolicyVersion,
    fact_ledger_batch_id: null,
    release_epoch: null,
    evidence_checked_at: null,
    last_verified_at: null,
    created_at: "2026-07-16T18:00:00.000Z",
    updated_at: "2026-07-16T18:00:00.000Z",
    ...overrides,
  };
}

function memberRow(
  cohort: number,
  sharedAwardId: string,
  kind: Stage1MemberRow["member_kind"],
): Stage1MemberRow {
  return {
    shared_award_id: sharedAwardId,
    cohort_key: stage1CohortIdentity[cohort - 1][1],
    member_kind: kind,
    reason: "Test fixture.",
    created_at: "2026-07-16T18:00:00.000Z",
    updated_at: "2026-07-16T18:00:00.000Z",
  };
}
