import { describe, expect, it } from "vitest";
import {
  assertStage1PromotionConfirmation,
  buildStage1ReviewedPromotionPlan,
  promotionRpcArgs,
  resolveStage1PromotionTargets,
  verifyStage1PromotionResult,
} from "./stage1-reviewed-promotion.mjs";
import {
  REQUIRED_SOURCE_ROLES,
  STAGE1_COHORT_DEFINITION,
  STAGE1_POLICY_VERSION,
} from "./stage1-cohort-readiness.mjs";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";

describe("Stage 1 reviewed promotion plan", () => {
  it("accepts one named award or the exact national 25, never a partial batch", () => {
    expect(resolveStage1PromotionTargets({ cohortKey: "marshall" })).toEqual([
      "marshall",
    ]);
    expect(resolveStage1PromotionTargets({ all: true })).toEqual(
      STAGE1_COHORT_DEFINITION.map((entry) => entry.cohortKey),
    );
    expect(() => resolveStage1PromotionTargets({})).toThrow(/exactly one/i);
    expect(() => resolveStage1PromotionTargets({ cohortKey: "marshall", all: true }))
      .toThrow(/exactly one/i);
    expect(() => buildPlan({
      targetKeys: ["marshall", "rhodes_us"],
    })).toThrow(/exactly one unique cohort or the exact national 25/i);
  });

  it("binds the evidence snapshot and all eight reviewed manifests to a stable hash", () => {
    const first = buildPlan();
    const shuffledDocument = manifestDocument(["marshall"]);
    shuffledDocument.cohorts[0].manifests.reverse();
    for (const entry of shuffledDocument.cohorts[0].manifests) {
      entry.evidence = Object.fromEntries(
        Object.entries(entry.evidence).reverse(),
      );
    }
    const second = buildPlan({ manifest: shuffledDocument });

    expect(first.manifest_entries).toHaveLength(REQUIRED_SOURCE_ROLES.length);
    expect(first.manifest_entries.map((entry) => entry.source_role)).toEqual(
      REQUIRED_SOURCE_ROLES,
    );
    expect(first.confirmation_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.confirmation_hash).toBe(first.confirmation_hash);
    expect(promotionRpcArgs(first)).toMatchObject({
      p_cohort_keys: ["marshall"],
      p_expected_review_hashes: { marshall: "a".repeat(64) },
      p_reason: "operator reviewed exact evidence",
      p_policy_version: STAGE1_POLICY_VERSION,
      p_actor: "operator@example.edu",
    });
  });

  it("rejects incomplete, missing, duplicate, or wrong-policy manifests", () => {
    const incomplete = manifestDocument(["marshall"]);
    incomplete.cohorts[0].manifests.pop();
    expect(() => buildPlan({ manifest: incomplete })).toThrow(/exactly 8/i);

    const missing = manifestDocument(["marshall"]);
    missing.cohorts[0].manifests[0].manifest_status = "missing";
    expect(() => buildPlan({ manifest: missing })).toThrow(/is not reviewed/i);

    const duplicate = manifestDocument(["marshall"]);
    duplicate.cohorts[0].manifests[1].source_role =
      duplicate.cohorts[0].manifests[0].source_role;
    expect(() => buildPlan({ manifest: duplicate })).toThrow(/duplicate source role/i);

    const wrongPolicy = manifestDocument(["marshall"]);
    wrongPolicy.cohorts[0].manifests[0].policy_version = "old-policy";
    expect(() => buildPlan({ manifest: wrongPolicy })).toThrow(/policy version/i);

    const incompleteEvidence = manifestDocument(["marshall"]);
    delete incompleteEvidence.cohorts[0].manifests[0].evidence.local_hashes;
    delete incompleteEvidence.cohorts[0].manifests[0]
      .evidence.source_bindings[SOURCE_ID].local_hashes;
    expect(() => buildPlan({ manifest: incompleteEvidence })).toThrow(
      /incomplete immutable source binding/i,
    );
  });

  it("requires an exact confirmation hash before apply", () => {
    const plan = buildPlan();
    expect(assertStage1PromotionConfirmation(plan, plan.confirmation_hash)).toBe(true);
    expect(() => assertStage1PromotionConfirmation(plan, "b".repeat(64)))
      .toThrow(/Nothing was applied/i);
    expect(() => assertStage1PromotionConfirmation(plan, "not-a-hash"))
      .toThrow(/64-character/i);
  });

  it("verifies single-award readiness without claiming the national release is public", () => {
    const plan = buildPlan();
    expect(verifyStage1PromotionResult({
      plan,
      promotedRows: [{ cohort_key: "marshall", publication_state: "verified_beta" }],
      effectiveRows: [{
        cohort_key: "marshall",
        cohort_ready: true,
        effectively_verified: false,
        effective_reason: "release_pending",
      }],
    })).toMatchObject({
      verified: true,
      target_count: 1,
      public_release_effective: false,
    });
  });

  it("allows all-25 verification to remain private pending release acceptance", () => {
    const targetKeys = resolveStage1PromotionTargets({ all: true });
    const plan = buildPlan({ targetKeys });
    const promotedRows = targetKeys.map((cohortKey) => ({
      cohort_key: cohortKey,
      publication_state: "verified_beta",
    }));
    const effectiveRows = targetKeys.map((cohortKey) => ({
      cohort_key: cohortKey,
      cohort_ready: true,
      effectively_verified: true,
      effective_reason: "verified",
    }));
    expect(verifyStage1PromotionResult({ plan, promotedRows, effectiveRows }))
      .toMatchObject({ public_release_effective: true, target_count: 25 });

    effectiveRows[0].effectively_verified = false;
    for (const row of effectiveRows) row.effectively_verified = false;
    expect(verifyStage1PromotionResult({ plan, promotedRows, effectiveRows }))
      .toMatchObject({
        public_release_effective: false,
        awaiting_release_acceptance: true,
        target_count: 25,
      });
  });
});

function buildPlan({
  targetKeys = ["marshall"],
  manifest = manifestDocument(targetKeys),
} = {}) {
  return buildStage1ReviewedPromotionPlan({
    targetCohortKeys: targetKeys,
    reviewRows: reviewRows(targetKeys),
    manifestDocument: manifest,
    actor: "operator@example.edu",
    reason: "operator reviewed exact evidence",
  });
}

function reviewRows(targetKeys) {
  return targetKeys.map((cohortKey, index) => ({
    cohort_key: cohortKey,
    review_hash: index === 0 ? "a".repeat(64) : index.toString(16).padStart(64, "0"),
    snapshot: {
      cohort_key: cohortKey,
      registry: {
        cohort_key: cohortKey,
        canonical_name: cohortKey,
        publication_state: "pending",
      },
      manifests: manifestDocument([cohortKey]).cohorts[0].manifests,
      members: [],
      bound_sources: [],
      bound_candidates: [],
      reconciled_fact_evidence: [],
      actionable_quarantine: [],
    },
  }));
}

function manifestDocument(targetKeys) {
  return {
    schema_version: 1,
    cohorts: targetKeys.map((cohortKey) => ({
      cohort_key: cohortKey,
      manifests: REQUIRED_SOURCE_ROLES.map((sourceRole) => ({
        source_role: sourceRole,
        manifest_status: "present",
        source_ids: [SOURCE_ID],
        evidence: {
          official: true,
          source_url: `https://example.edu/${cohortKey}/${sourceRole}`,
          supporting_text: `${cohortKey}:${sourceRole}`,
          captured_at: "2026-07-16T18:00:00.000Z",
          r2_verified_at: "2026-07-16T18:05:00.000Z",
          local_verified_at: "2026-07-16T18:06:00.000Z",
          cycle: "2027",
          reconciliation_status: "verified",
          policy_version: STAGE1_POLICY_VERSION,
          fact_candidate_ids: [CANDIDATE_ID],
          source_bindings: {
            [SOURCE_ID]: {
              source_url: `https://example.edu/${cohortKey}/${sourceRole}`,
              object_keys: { page: `${cohortKey}/${sourceRole}/page.jpg` },
              hashes: { image: "image-hash", text: "text-hash" },
              r2_hashes: { image: "image-hash", text: "text-hash" },
              local_hashes: { image: "image-hash", text: "text-hash" },
              captured_at: "2026-07-16T18:00:00.000Z",
            },
          },
          candidate_bindings: {
            [CANDIDATE_ID]: {
              source_id: SOURCE_ID,
              source_role: sourceRole,
              field_name: "eligibility",
            },
          },
        },
        checked_at: "2026-07-16T18:00:00.000Z",
        policy_version: STAGE1_POLICY_VERSION,
      })),
    })),
  };
}
