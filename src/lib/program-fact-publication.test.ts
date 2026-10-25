import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));

import { applyProgramFactPublication } from "@/lib/program-fact-publication";
import { buildStage1PublicationIndex, stage1PublicationPolicyVersion, type Stage1RegistryRow } from "@/lib/stage1-publication";
import { stage1CohortIdentity, stage1CohortIdentityHash, stage1CohortIdentityVersion } from "@/lib/stage1-cohort-identity";
import { programFactPublicValues, PROGRAM_FACT_FIELDS } from "../../scripts/lib/program-text-facts.mjs";

const at = "2026-10-25T16:00:00.000Z";
const epoch = "11111111-1111-4111-8111-111111111111";
const revision = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;

function fixture() {
  const registries: Stage1RegistryRow[] = stage1CohortIdentity.map(identity => ({
    cohort_key: identity[1], launch_rank: identity[0], canonical_name: identity[2], canonical_shared_award_id: identity[3],
    canonical_slug: identity[4], official_homepage: identity[5], publication_state: "verified_beta", state_reason: "Verified original identity.",
    policy_version: stage1PublicationPolicyVersion, fact_ledger_batch_id: null, release_epoch: epoch,
    evidence_checked_at: at, last_verified_at: at, created_at: at, updated_at: at,
  }));
  const index = buildStage1PublicationIndex({
    registryRows: registries,
    memberRows: registries.flatMap(row => [
      { shared_award_id: row.canonical_shared_award_id, cohort_key: row.cohort_key, member_kind: "canonical" as const, reason: "Canonical identity.", created_at: at, updated_at: at },
      { shared_award_id: id(300 + row.launch_rank), cohort_key: row.cohort_key, member_kind: "alias" as const, reason: "Reviewed alias.", created_at: at, updated_at: at },
    ]), identityRules: [],
    effectiveRows: registries.map(row => ({ cohort_key: row.cohort_key, effectively_verified: true, effective_reason: "verified", evaluated_at: at,
      cohort_ready: true, cohort_readiness_reason: "verified", release_epoch: epoch, release_state: "verified_beta" as const,
      release_policy_version: stage1PublicationPolicyVersion, release_identity_version: stage1CohortIdentityVersion, release_identity_hash: stage1CohortIdentityHash })),
    release: { releaseKey: "stage1-national-25", releaseState: "verified_beta", releaseEpoch: epoch, policyVersion: stage1PublicationPolicyVersion,
      cohortIdentityVersion: stage1CohortIdentityVersion, cohortIdentityHash: stage1CohortIdentityHash, activatedAt: at, effectivelyReleased: true, effectiveReason: "verified" },
    allowedSourceIdsByCohortKey: new Map(registries.map(row => [row.cohort_key, [id(row.launch_rank)]])),
    publishedFactsByCohortKey: new Map(registries.map(row => [row.cohort_key, { overview: `Previous approved ${row.canonical_name}.` }])),
    reviewedHomepageByCohortKey: new Map(registries.map(row => [row.cohort_key, { sourceId: id(row.launch_rank), url: row.official_homepage }])),
    now: new Date(at),
  });
  const snapshot = { schema: "awardping.program-fact-publication.v1", revision, active: true,
    cohorts: registries.map(row => ({ cohort_key: row.cohort_key, review_id: id(100 + row.launch_rank), award_id: row.canonical_shared_award_id,
      epoch, reviewed_at: at, current: true, source_ids: [id(200 + row.launch_rank)],
      public_facts: programFactPublicValues({ cycle: "2027", fields: PROGRAM_FACT_FIELDS.map(field => ({ field,
        status: field === "overview" ? "verified" : "not_published", note: "All reviewed official sources omit this detail.",
        items: field === "overview" ? [{ value: `Approved ${row.canonical_name}.`, track: null, support: [] }] : [] })) }) as unknown as Record<string, unknown> })) };
  return { index, snapshot };
}

describe("one approved current-details release on the existing identity gate", () => {
  it("does not expose drafts or rewrite the existing release while the fact batch is inactive", () => {
    const { index } = fixture();
    expect(index.available).toBe(true); expect(index.verifiedEntries).toHaveLength(25);
    const result = applyProgramFactPublication(index, { schema: "awardping.program-fact-publication.v1", revision, active: false, cohorts: [] });
    expect(result).toBe(index);
    expect(result.entries.every(entry => entry.textFactReview === undefined)).toBe(true);
    expect(result.entries[0].publishedFacts).toEqual(index.entries[0].publishedFacts);
  });

  it("atomically replaces all 25 snapshots without changing canonical identities, aliases or the pinned homepages", () => {
    const { index, snapshot } = fixture(); snapshot.cohorts.reverse();
    const result = applyProgramFactPublication(index, snapshot);
    expect(result).not.toBe(index); expect(result.release).toBe(index.release);
    expect(result.verifiedCanonicalAwardIds).toEqual(index.verifiedCanonicalAwardIds);
    expect(result.verifiedMemberAwardIds).toEqual(index.verifiedMemberAwardIds);
    for (const [offset, entry] of result.entries.entries()) {
      const original = index.entries[offset], row = snapshot.cohorts.find(row => row.cohort_key === entry.registry.cohort_key)!;
      expect(entry.registry).toBe(original.registry);
      expect(entry.memberAwardIds).toEqual(original.memberAwardIds);
      expect(entry.publishedFacts).toEqual(row.public_facts);
      expect(original.publishedFacts).not.toEqual(row.public_facts);
      expect(entry.allowedSourceIds).toEqual([...row.source_ids, original.officialHomepageSourceId]);
      expect(entry.allowedSourceIdSet.has(original.officialHomepageSourceId!)).toBe(true);
      expect(entry.officialHomepageUrl).toBe(original.registry.official_homepage);
      expect(entry.textFactReview).toEqual({ id: row.review_id, reviewedAt: at, current: true, releaseRevision: revision });
      expect(result.entryByCohortKey.get(entry.registry.cohort_key)).toBe(entry);
      for (const member of entry.memberAwardIds) expect(result.entryByMemberAwardId.get(member)).toBe(entry);
    }
  });

  it("keeps the last approved facts while explicitly marking an award requiring reconciliation", () => {
    const { index, snapshot } = fixture(); snapshot.cohorts[0].current = false;
    const result = applyProgramFactPublication(index, snapshot);
    expect(result.entries[0].publishedFacts).toEqual(snapshot.cohorts[0].public_facts);
    expect(result.entries[0].textFactReview?.current).toBe(false);
    expect(result.entries[1].textFactReview?.current).toBe(true);
  });

  it.each(["unavailable", "unverified", "partial"])("never opens a %s identity gate", mode => {
    const { index, snapshot } = fixture();
    if (mode === "unavailable") index.available = false;
    if (mode === "unverified") index.verifiedEntries = [];
    if (mode === "partial") index.verifiedEntries.pop();
    expect(() => applyProgramFactPublication(index, snapshot)).toThrow("Incomplete program-fact release");
  });

  it.each([
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts.pop(); },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts.push(s.cohorts[0]); },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0] = structuredClone(s.cohorts[1]); },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].award_id = s.cohorts[1].award_id; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].cohort_key = "unreviewed-cohort"; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].source_ids = []; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].source_ids.push(s.cohorts[0].source_ids[0]); },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].source_ids = s.cohorts[1].source_ids; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].source_ids = ["not-a-source-identity"]; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].review_id = "draft"; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].review_id = s.cohorts[1].review_id; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].epoch = "wrong-epoch"; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].reviewed_at = "unapproved"; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].public_facts.overview = ""; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].public_facts.reviewed_cycle = ""; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { delete s.cohorts[0].public_facts.deadline; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].public_facts.deadline = []; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].public_facts.eligibility = "Unreviewed scalar instead of source-supported list"; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].public_facts.unsupported_fact = "extra"; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.cohorts[0].public_facts.not_published_fields = ["unknown_field"]; },
    (s: ReturnType<typeof fixture>["snapshot"]) => { s.active = false; },
  ])("fails closed on missing, duplicate, cross-program or unsupported release data %#", mutate => {
    const { index, snapshot } = fixture(); mutate(snapshot);
    expect(() => applyProgramFactPublication(index, snapshot)).toThrow();
    expect(index.entries.every(entry => entry.textFactReview === undefined)).toBe(true);
  });
});
