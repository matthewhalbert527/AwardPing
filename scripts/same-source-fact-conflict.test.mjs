import { describe, expect, it } from "vitest";
import {
  auditPublicAwardPage as auditScript,
  buildCandidateDispositionEntries,
  buildFactCandidatesFromSources as buildScript,
  reconcileAwardFacts as reconcileScript,
} from "./lib/award-fact-reconciliation.mjs";
import {
  auditPublicAwardPage as auditApp,
  buildFactCandidatesFromSources as buildApp,
  reconcileAwardFacts as reconcileApp,
} from "../src/lib/award-fact-reconciliation.ts";

// Synthetic evidence: this exercises conflict representation, not the truth of
// either requirement, an official capture, or permission to publish a fact.
const award = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Example Fellowship",
  official_homepage: "https://example.edu/fellowship",
};
const overview = "Example Fellowship supports postgraduate study.";
const source = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  shared_award_id: award.id,
  url: award.official_homepage,
  title: award.name,
  display_title: award.name,
  page_type: "homepage",
  page_metadata_generated_at: "2026-09-09T00:00:00.000Z",
  page_metadata_model: "test",
  confidence: 90,
  page_metadata: {
    baseline_facts: {
      status: "succeeded", award_name_seen: true, award_relevance: "primary",
      cycle_relevance: "evergreen", confidence: "high", quality_flags: [],
      overview, evidence_quotes: [overview],
    },
  },
};
const candidates = [
  { id: "11111111-1111-4111-8111-111111111111", raw_value: ["Two 500-word essays"], evidence_quote: "Submit two 500-word essays.", evidence_location: "How to apply" },
  { id: "22222222-2222-4222-8222-222222222222", raw_value: ["Four 200-word essays"], evidence_quote: "Submit four 200-word essays.", evidence_location: "Required documents" },
].map((candidate) => ({
  ...candidate, shared_award_id: award.id, shared_award_source_id: source.id,
  field_name: "application_materials", confidence: "high", candidate_status: "pending",
}));
const overviewCandidate = {
  id: "33333333-3333-4333-8333-333333333333",
  shared_award_id: award.id, shared_award_source_id: source.id,
  field_name: "overview", raw_value: overview, evidence_quote: overview, confidence: "high",
};
const options = { now: "2026-09-09T00:00:00.000Z", generatedAt: "2026-09-09T00:00:00.000Z" };

describe.each([
  ["worker", reconcileScript, auditScript, buildScript],
  ["application", reconcileApp, auditApp, buildApp],
])("same-source conflict contract: %s", (_name, reconcile, audit, build) => {
  it.each([false, true])("retains both explicit claims without selecting either disposition (reversed=%s)", (reversed) => {
    const input = structuredClone([overviewCandidate, ...(reversed ? [...candidates].reverse() : candidates)]);
    const original = structuredClone(input);
    const result = reconcile(award, [source], input, options);
    expect(result.rejected).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    const [conflict] = result.conflicts;
    expect(conflict).toMatchObject({ field_name: "application_materials", severity: "warning", reason: "incompatible_values" });
    expect(conflict.values.map(({ candidate }) => candidate.id).sort()).toEqual(candidates.map(({ id }) => id).sort());
    for (const claim of candidates) {
      expect(conflict.values.find(({ candidate }) => candidate.id === claim.id)).toMatchObject({
        value: claim.raw_value,
        candidate: { id: claim.id, evidence_quote: claim.evidence_quote, evidence_location: claim.evidence_location },
        source: { id: source.id },
      });
    }
    const dispositions = buildCandidateDispositionEntries(result, new Set(result.conflicts.map(({ field_name }) => field_name)))
      .filter(({ candidate }) => candidate.field_name === "application_materials");
    expect(dispositions.map(({ candidate_status }) => candidate_status).sort()).toEqual(["conflicted", "superseded"]);
    expect(dispositions.every(({ rejection_reason }) => rejection_reason === null)).toBe(true);
    expect(dispositions.find(({ candidate_status }) => candidate_status === "superseded").selected_reason).toBeNull();
    expect(dispositions.map(({ candidate }) => candidate)).toEqual(expect.arrayContaining(candidates.map((claim) => expect.objectContaining(claim))));
    // A warning audit is not publication approval. The current pure result
    // still contains a ranked value; neither truth nor ledger promotion follows.
    expect(candidates.map(({ raw_value }) => raw_value)).toContainEqual(result.selectedFacts.application_materials);
    expect(result.selectedFacts.application_materials).toEqual(result.selected.application_materials.value);
    const assessment = audit(award, result.selectedFacts, [source], { reconciliation: result, now: options.now });
    expect(assessment.findings).toContainEqual(expect.objectContaining({
      code: "field_conflict", field_name: "application_materials", severity: "warning",
    }));
    expect(assessment.should_block_publication).toBe(false);
    expect(input).toEqual(original);
  });

  it("does not pretend one baseline list is already two separate evidence claims", () => {
    const baseline = structuredClone(source);
    baseline.page_metadata.baseline_facts.application_materials = candidates.flatMap(({ raw_value }) => raw_value);
    const generated = build(award, [baseline]).filter(({ field_name }) => field_name === "application_materials");
    expect(generated).toHaveLength(1);
    expect(generated[0].raw_value).toEqual(["Two 500-word essays", "Four 200-word essays"]);
  });
});
