import { describe, expect, it } from "vitest";
import {
  auditPublicAwardPage,
  buildFactCandidatesFromSources,
  preserveLastKnownGoodAmountFacts,
  reconcileAwardFacts,
  type ReconciliationAward,
  type ReconciliationSource,
} from "@/lib/award-fact-reconciliation";

function source(overrides: Partial<ReconciliationSource>): ReconciliationSource {
  return {
    id: overrides.id || "source",
    shared_award_id: "award-luce-acls",
    url: overrides.url || "https://www.acls.org/competitions/luce-acls-dissertation-fellowships-in-american-art/",
    title: overrides.title || "Source",
    display_title: overrides.display_title ?? overrides.title ?? "Source",
    page_description: overrides.page_description ?? null,
    page_metadata_generated_at: "2026-07-01T00:00:00.000Z",
    page_metadata_model: "test",
    page_metadata: overrides.page_metadata || {},
    page_type: overrides.page_type || "homepage",
    admin_review_status: "open",
    confidence: 90,
    ...overrides,
  };
}

const award: ReconciliationAward = {
  id: "award-luce-acls",
  name: "Luce/ACLS Dissertation Fellowships in American Art",
  slug: "luce-acls-dissertation-fellowships-in-american-art",
  official_homepage: "https://www.acls.org/competitions/luce-acls-dissertation-fellowships-in-american-art/",
};

describe("award fact reconciliation", () => {
  it("rejects sibling ACLS prize facts from the Luce/ACLS public page", () => {
    const official = source({
      id: "official",
      title: "Luce/ACLS Dissertation Fellowships in American Art",
      display_title: "Luce/ACLS Dissertation Fellowships in American Art",
      page_type: "homepage",
      page_description:
        "Fellowships supporting advanced graduate students completing dissertations in American art.",
      page_metadata: {
        baseline_facts: {
          status: "succeeded",
          display_title: "Luce/ACLS Dissertation Fellowships in American Art",
          page_description:
            "Fellowships supporting advanced graduate students completing dissertations in American art.",
          award_name_seen: true,
          award_relevance: "primary",
          cycle_relevance: "evergreen",
          confidence: "high",
          evidence_quotes: [
            "Luce/ACLS Dissertation Fellowships in American Art",
            "$38,000 stipend",
            "up to $4,500 for travel and research",
            "Applications were due October 29, 2025",
          ],
          deadline: "October 29, 2025",
          cycle_status: "deadline_passed",
          award_amounts: ["$38,000 stipend", "up to $4,500 for travel and research"],
          stipend: "$38,000",
          travel_research_allowance: "up to $4,500",
          eligibility: ["Advanced graduate students completing dissertations in American art"],
          application_materials: ["Dissertation proposal", "Bibliography", "Two reference letters"],
          important_dates: ["Application deadline: October 29, 2025"],
          quality_flags: [],
        },
      },
    });

    const faq = source({
      id: "faq",
      url: "https://www.acls.org/competitions/luce-acls-dissertation-fellowships-in-american-art/faq/",
      title: "Luce/ACLS Dissertation Fellowships FAQ",
      display_title: "FAQ",
      page_type: "faq",
      page_metadata: {
        baseline_facts: {
          status: "succeeded",
          display_title: "Luce/ACLS Dissertation Fellowships FAQ",
          page_description: "FAQ for the Luce/ACLS Dissertation Fellowships in American Art.",
          award_name_seen: true,
          award_relevance: "supporting",
          cycle_relevance: "evergreen",
          confidence: "high",
          evidence_quotes: ["Luce/ACLS Dissertation Fellowships in American Art", "$38,000 stipend"],
          eligibility: ["Advanced graduate students completing dissertations in American art"],
          quality_flags: [],
        },
      },
    });

    const sibling = source({
      id: "sibling",
      url: "https://www.acls.org/competitions/open-access-book-prizes/sample-entry-form/",
      title: "ACLS 2026 OA Book Prizes Sample Entry Form",
      display_title: "Open Access Book Prize Sample Entry Form",
      page_description: "Sample entry form for the Arcadia Open Access Publishing Award.",
      page_type: "application",
      page_metadata: {
        baseline_facts: {
          status: "succeeded",
          display_title: "ACLS 2026 OA Book Prizes Sample Entry Form",
          page_description: "Sample entry form for the Arcadia Open Access Publishing Award.",
          award_name_seen: true,
          award_relevance: "primary",
          cycle_relevance: "current_or_upcoming",
          confidence: "high",
          evidence_quotes: [
            "Open Access Book Prize",
            "Arcadia Open Access Publishing Award",
            "October 28, 2026",
          ],
          deadline: "October 28, 2026",
          application_materials: ["Book manuscript", "Publisher letter"],
          quality_flags: [],
        },
      },
    });

    const sources = [official, faq, sibling];
    const candidates = buildFactCandidatesFromSources(award, sources);
    const reconciliation = reconcileAwardFacts(award, sources, candidates, {
      now: "2026-07-09T00:00:00.000Z",
      generatedAt: "2026-07-09T00:00:00.000Z",
    });
    const audit = auditPublicAwardPage(award, reconciliation.selectedFacts, sources, { reconciliation });

    expect(reconciliation.selectedFacts.overview).not.toContain("Open Access Book Prize");
    expect(reconciliation.selectedFacts.overview).not.toContain("Arcadia Open Access Publishing Award");
    expect(reconciliation.selectedFacts.deadline).not.toBe("October 28, 2026");
    expect(reconciliation.selectedFacts.deadline).toBe("October 29, 2025");
    expect(["deadline_passed", "archived_or_information_only"]).toContain(reconciliation.selectedFacts.cycle_status);
    expect(reconciliation.selectedFacts.award_amounts.join(" ")).toContain("$38,000");
    expect(reconciliation.selectedFacts.award_amounts.join(" ")).toContain("$4,500");
    expect(reconciliation.rejected.some((item) => item.source?.id === "sibling" && item.reason === "sibling_program_identity_mismatch")).toBe(true);
    expect(audit.should_block_publication).toBe(false);

    const contaminated = auditPublicAwardPage(
      award,
      {
        ...reconciliation.selectedFacts,
        overview: "Sample entry form for the Arcadia Open Access Publishing Award.",
        deadline: "October 28, 2026",
      },
      sources,
      { reconciliation },
    );
    expect(contaminated.should_block_publication).toBe(true);
  });

  it("publishes other verified fields while preserving a last-known-good amount for review", () => {
    const official = source({
      id: "official-amount",
      title: award.name,
      display_title: award.name,
      page_metadata: {
        baseline_facts: {
          status: "succeeded",
          display_title: award.name,
          page_description: "Dissertation fellowships supporting graduate students in American art.",
          award_name_seen: true,
          award_relevance: "primary",
          cycle_relevance: "evergreen",
          confidence: "high",
          evidence_quotes: [award.name, "$38,000 stipend"],
          award_amounts: ["$38,000 stipend"],
          eligibility: ["Graduate students completing dissertations in American art"],
          quality_flags: [],
        },
      },
    });
    const sources = [official];
    const reconciliation = reconcileAwardFacts(
      award,
      sources,
      buildFactCandidatesFromSources(award, sources),
      { now: "2026-07-13T00:00:00.000Z" },
    );
    const selectedWithoutAmount = {
      ...reconciliation.selectedFacts,
      award_amounts: [],
      stipend: null,
      travel_research_allowance: null,
    };
    const audit = auditPublicAwardPage(award, selectedWithoutAmount, sources, { reconciliation });
    const publishable = preserveLastKnownGoodAmountFacts(selectedWithoutAmount, {
      award_amounts: ["$37,000 prior-cycle stipend"],
      stipend: "$37,000",
    });

    expect(audit.audit_status).toBe("warnings");
    expect(audit.should_block_publication).toBe(false);
    expect(audit.findings).toContainEqual(expect.objectContaining({
      code: "missing_amount_with_official_evidence",
      severity: "warning",
    }));
    expect(publishable.award_amounts).toEqual(["$37,000 prior-cycle stipend"]);
    expect(publishable.stipend).toBe("$37,000");
    expect(publishable.reconciliation.review_flags).toContain("amount_preserved_pending_review");
  });

  it("keeps retained-alias candidates bound to the award that owns their source", () => {
    const aliasSource = source({
      id: "alias-eligibility",
      shared_award_id: "retained-alias-award",
      title: award.name,
      page_type: "eligibility",
      page_metadata: {
        baseline_facts: {
          status: "succeeded",
          award_relevance: "supporting",
          award_name_seen: true,
          confidence: "high",
          eligibility: ["Applicants must be enrolled graduate students."],
          evidence_quotes: ["Applicants must be enrolled graduate students."],
        },
      },
    });

    const candidates = buildFactCandidatesFromSources(award, [aliasSource]);

    expect(candidates).not.toHaveLength(0);
    expect(candidates.every((candidate) =>
      candidate.shared_award_id === "retained-alias-award" &&
      candidate.shared_award_source_id === "alias-eligibility"
    )).toBe(true);
  });
});
