import { describe, expect, it } from "vitest";
import { auditPublicAwardPage, buildFactCandidatesFromSources, reconcileAwardFacts } from "./lib/award-fact-reconciliation.mjs";

describe("worker amount warning evidence scope", () => {
  it("does not call an unbound proposal verified amount evidence", () => {
    const award = { id: "award-fixture", name: "Example Research Fellowship", official_homepage: "https://example.edu/research-fellowship" };
    const source = {
      id: "source-fixture",
      shared_award_id: award.id,
      url: award.official_homepage,
      title: award.name,
      display_title: award.name,
      page_type: "homepage",
      admin_review_status: "open",
      confidence: 90,
      page_metadata_generated_at: "2026-09-09T00:00:00.000Z",
      page_metadata_model: "test",
      page_metadata: { baseline_facts: {
        status: "succeeded",
        display_title: award.name,
        page_description: "The Example Research Fellowship supports graduate research.",
        award_name_seen: true,
        award_relevance: "primary",
        cycle_relevance: "evergreen",
        confidence: "high",
        evidence_quotes: ["Example Research Fellowship applications close March 1, 2027."],
        award_amounts: ["$5,000 stipend"],
        quality_flags: [],
      } },
    };
    const candidates = buildFactCandidatesFromSources(award, [source]).map((candidate) => ({
      ...candidate, evidence_quote: null, evidence_location: null,
    }));
    const reconciliation = reconcileAwardFacts(award, [source], candidates, { now: "2026-09-09T00:00:00.000Z" });
    const audit = auditPublicAwardPage(award, {
      ...reconciliation.selectedFacts, award_amounts: [], stipend: null, travel_research_allowance: null,
    }, [source], { reconciliation });
    expect(audit.findings).toContainEqual({
      code: "missing_amount_with_official_evidence",
      severity: "warning",
      field_name: "award_amounts",
      message: "An award amount was proposed but not selected. Check the source for supporting text and the applicable cycle. Keep any last-known-good amount pending review.",
    });
    expect(audit.should_block_publication).toBe(false);
    expect(audit.suggested_fixes).toContainEqual({ field_name: "award_amounts", reason: "review_official_amount_evidence" });
  });
});
