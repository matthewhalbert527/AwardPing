import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  planMissingFactCandidateMaterialization,
  reconcileAwardFacts,
  resolveStage1ReconciliationTarget,
} from "./lib/award-fact-reconciliation.mjs";

const CANONICAL_ID = "11111111-1111-4111-8111-111111111111";
const ALIAS_ID = "22222222-2222-4222-8222-222222222222";

describe("Stage 1 alias reconciliation", () => {
  it("routes an alias trigger to the canonical award while retaining every member source owner", async () => {
    const target = await resolveStage1ReconciliationTarget(
      resolverSupabase(),
      ALIAS_ID,
    );

    expect(target).toEqual({
      canonicalAwardId: CANONICAL_ID,
      cohortKey: "marshall",
      memberAwardIds: [CANONICAL_ID, ALIAS_ID],
      canonicalized: true,
    });
  });

  it("keeps non-Stage-1 reconciliation compatible before the registry migration is deployed", async () => {
    const target = await resolveStage1ReconciliationTarget(
      resolverSupabase({ missingRegistry: true }),
      ALIAS_ID,
    );

    expect(target).toEqual({
      canonicalAwardId: ALIAS_ID,
      cohortKey: null,
      memberAwardIds: [ALIAS_ID],
      canonicalized: false,
    });
  });

  it("loads sources and candidates across the resolved member IDs before canonical publication", () => {
    const worker = readFileSync(
      new URL("./reconcile-impacted-award-pages.mjs", import.meta.url),
      "utf8",
    );
    const library = readFileSync(
      new URL("./lib/award-fact-reconciliation.mjs", import.meta.url),
      "utf8",
    );

    expect(worker).toContain("const reconciliationAwardIds = stage1Scope.memberAwardIds.length");
    expect(worker).toContain("loadAwardSources(reconciliationAwardIds)");
    expect(worker).toContain("loadAwardFactCandidates(reconciliationAwardIds)");
    expect(worker).toContain('.in("shared_award_id", ids)');
    expect(library).toContain("shared_award_id: source.shared_award_id || award.id");
    expect(worker).toContain("stage1_canonicalized:");
  });

  it("routes automatic Stage 1 work to explicit re-review before candidate loading or materialization", () => {
    const worker = readFileSync(
      new URL("./reconcile-impacted-award-pages.mjs", import.meta.url),
      "utf8",
    );
    const reviewBoundary = worker.indexOf("if (stage1Scope.cohortKey) {");
    const sourceLoad = worker.indexOf("loadAwardSources(reconciliationAwardIds)");
    const materialization = worker.indexOf("planMissingFactCandidateMaterialization(");

    expect(worker).toContain("isExplicitReviewedStage1Queue(queueRow)");
    expect(worker).toContain("stage1_explicit_review_required:");
    expect(worker).toContain("automatic_reconciliation_blocked: true");
    expect(reviewBoundary).toBeGreaterThan(-1);
    expect(sourceLoad).toBeGreaterThan(reviewBoundary);
    expect(materialization).toBeGreaterThan(reviewBoundary);
  });

  it("materializes alias-source facts even when canonical candidates already exist", () => {
    const canonicalSource = factSource(CANONICAL_ID, "canonical-source", "Canonical eligibility");
    const aliasSource = factSource(ALIAS_ID, "alias-source", "Alias eligibility");
    const canonicalCandidate = {
      shared_award_id: CANONICAL_ID,
      shared_award_source_id: "canonical-source",
      field_name: "eligibility",
      raw_value: ["Canonical eligibility"],
      normalized_value: ["Canonical eligibility"],
      evidence_quote: "Canonical eligibility",
      evidence_location: null,
    };
    const legacyWrongOwnerCandidate = {
      shared_award_id: CANONICAL_ID,
      shared_award_source_id: "alias-source",
      field_name: "eligibility",
      raw_value: ["Alias eligibility"],
      normalized_value: ["Alias eligibility"],
      evidence_quote: "Alias eligibility",
      evidence_location: null,
    };

    const plan = planMissingFactCandidateMaterialization(
      { id: CANONICAL_ID, name: "Marshall Scholarship" },
      [canonicalSource, aliasSource],
      [canonicalCandidate, legacyWrongOwnerCandidate],
    );

    expect(plan.usableLoadedCandidates).toEqual([canonicalCandidate]);
    expect(plan.sourceOwnerMismatches).toEqual([legacyWrongOwnerCandidate]);
    expect(plan.generatedCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        shared_award_id: ALIAS_ID,
        shared_award_source_id: "alias-source",
        field_name: "eligibility",
        normalized_value: ["Alias eligibility"],
      }),
    ]));
    expect(plan.generatedCandidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        shared_award_source_id: "canonical-source",
        field_name: "eligibility",
        normalized_value: ["Canonical eligibility"],
      }),
    ]));
  });

  it("uses rejected identities to prevent regeneration without reconsidering them", () => {
    const source = factSource(
      CANONICAL_ID,
      "canonical-source",
      "Permanently ineligible wording",
    );
    const rejectedCandidate = {
      id: "33333333-3333-4333-8333-333333333333",
      shared_award_id: CANONICAL_ID,
      shared_award_source_id: "canonical-source",
      field_name: "eligibility",
      raw_value: ["Permanently ineligible wording"],
      normalized_value: ["Permanently ineligible wording"],
      evidence_quote: "Permanently ineligible wording",
      evidence_location: null,
      candidate_status: "rejected",
    };

    const plan = planMissingFactCandidateMaterialization(
      { id: CANONICAL_ID, name: "Marshall Scholarship" },
      [source],
      [rejectedCandidate],
    );

    expect(plan.usableLoadedCandidates).toEqual([]);
    expect(plan.generatedCandidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        shared_award_source_id: "canonical-source",
        field_name: "eligibility",
        normalized_value: ["Permanently ineligible wording"],
      }),
    ]));
    expect(plan.sourceOwnerMismatches).toEqual([]);
  });

  it("reconsiders valid superseded evidence without rematerializing it", () => {
    const source = factSource(
      CANONICAL_ID,
      "canonical-source",
      "Still-valid eligibility wording",
    );
    const supersededCandidate = {
      id: "44444444-4444-4444-8444-444444444444",
      shared_award_id: CANONICAL_ID,
      shared_award_source_id: "canonical-source",
      field_name: "eligibility",
      raw_value: ["Still-valid eligibility wording"],
      normalized_value: ["Still-valid eligibility wording"],
      evidence_quote: "Still-valid eligibility wording",
      evidence_location: null,
      candidate_status: "superseded",
    };

    const plan = planMissingFactCandidateMaterialization(
      { id: CANONICAL_ID, name: "Marshall Scholarship" },
      [source],
      [supersededCandidate],
    );

    expect(plan.usableLoadedCandidates).toEqual([supersededCandidate]);
    expect(plan.generatedCandidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        shared_award_source_id: "canonical-source",
        field_name: "eligibility",
        normalized_value: ["Still-valid eligibility wording"],
      }),
    ]));
    expect(plan.sourceOwnerMismatches).toEqual([]);
    const reconciliation = reconcileAwardFacts(
      { id: CANONICAL_ID, name: "Marshall Scholarship" },
      [source],
      [...plan.usableLoadedCandidates, ...plan.generatedCandidates],
      { now: new Date("2026-07-17T12:00:00.000Z") },
    );
    expect(reconciliation.selected.eligibility.candidate.id).toBe(
      supersededCandidate.id,
    );
  });

  it("does not replay superseded evidence that is absent from the current source facts", () => {
    const award = { id: CANONICAL_ID, name: "Marshall Scholarship" };
    const source = factSource(
      CANONICAL_ID,
      "canonical-source",
      "Current eligibility wording",
    );
    const staleSupersededCandidate = {
      id: "55555555-5555-4555-8555-555555555555",
      shared_award_id: CANONICAL_ID,
      shared_award_source_id: "canonical-source",
      field_name: "eligibility",
      raw_value: ["Stale eligibility wording"],
      normalized_value: ["Stale eligibility wording"],
      evidence_quote: "Stale eligibility wording",
      evidence_location: null,
      candidate_status: "superseded",
    };

    const plan = planMissingFactCandidateMaterialization(
      award,
      [source],
      [staleSupersededCandidate],
    );
    const reconciliation = reconcileAwardFacts(
      award,
      [source],
      [...plan.usableLoadedCandidates, ...plan.generatedCandidates],
      { now: new Date("2026-07-17T12:00:00.000Z") },
    );

    expect(plan.usableLoadedCandidates).not.toContain(
      staleSupersededCandidate,
    );
    expect(plan.generatedCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        shared_award_source_id: "canonical-source",
        field_name: "eligibility",
        normalized_value: ["Current eligibility wording"],
      }),
    ]));
    expect(reconciliation.selectedFacts.eligibility).toEqual([
      "Current eligibility wording",
    ]);
    expect(reconciliation.selected.eligibility.candidate).not.toBe(
      staleSupersededCandidate,
    );
  });
});

function factSource(sharedAwardId, id, eligibility) {
  return {
    id,
    shared_award_id: sharedAwardId,
    url: `https://example.edu/${id}`,
    title: "Marshall Scholarship eligibility",
    display_title: "Marshall Scholarship eligibility",
    page_type: "eligibility",
    admin_review_status: "open",
    confidence: 90,
    page_metadata_generated_at: "2026-07-16T18:00:00.000Z",
    page_metadata_model: "fixture",
    page_metadata: {
      baseline_facts: {
        status: "succeeded",
        award_relevance: "supporting",
        cycle_relevance: "evergreen",
        award_name_seen: true,
        confidence: "high",
        eligibility: [eligibility],
        evidence_quotes: [eligibility],
        quality_flags: [],
      },
    },
  };
}

function resolverSupabase({ missingRegistry = false } = {}) {
  return {
    from(table) {
      let selected = "";
      const builder = {
        select(columns) {
          selected = columns;
          return builder;
        },
        eq() {
          return builder;
        },
        async maybeSingle() {
          if (table === "stage1_award_members" && selected === "cohort_key") {
            if (missingRegistry) {
              return {
                data: null,
                error: { message: 'relation "stage1_award_members" does not exist' },
              };
            }
            return { data: { cohort_key: "marshall" }, error: null };
          }
          if (table === "stage1_award_registry") {
            return {
              data: { canonical_shared_award_id: CANONICAL_ID },
              error: null,
            };
          }
          throw new Error(`Unexpected maybeSingle query: ${table}/${selected}`);
        },
        then(resolve, reject) {
          if (table !== "stage1_award_members" || selected !== "shared_award_id") {
            return Promise.reject(
              new Error(`Unexpected list query: ${table}/${selected}`),
            ).then(resolve, reject);
          }
          return Promise.resolve({
            data: [
              { shared_award_id: CANONICAL_ID },
              { shared_award_id: ALIAS_ID },
            ],
            error: null,
          }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}
