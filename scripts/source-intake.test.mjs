import { describe, expect, it } from "vitest";
import {
  baselineFactsFromIntakeReview,
  matchSourceToExistingAward,
  normalizeGeminiIntakeResult,
  shouldCreateNewAwardFromIntake,
  sourceLikeFromIntake,
  validateIntakeAiDecision,
} from "./lib/source-intake.mjs";

const request = {
  id: "request-1",
  award_name: "Example Research Fellowship",
  homepage_url: "https://example.edu/research-fellowship",
  normalized_url: "https://example.edu/research-fellowship",
  submitted_url: "https://example.edu/research-fellowship",
  notes: null,
  intake_type: "award_homepage",
};

const capture = {
  final_url: "https://example.edu/research-fellowship",
  canonical_url: "https://example.edu/research-fellowship",
  title: "Example Research Fellowship",
  page_description: "Official fellowship page with application details.",
  text: "Example Research Fellowship applications close March 1. The award provides a $5,000 stipend.",
  content_type: "text/html",
};

const acceptedReview = {
  status: "accepted",
  detected_award_name: "Example Research Fellowship",
  detected_sponsor: "Example University",
  source_relevance: "primary",
  cycle_relevance: "current_or_upcoming",
  page_type: "homepage",
  officialness: "official",
  confidence: "high",
  evidence_quotes: ["Example Research Fellowship applications close March 1."],
  facts: {
    description: "Official fellowship page with application details.",
    deadline: "March 1",
    amount: "$5,000 stipend",
    eligibility: ["Graduate students"],
    application_materials: ["Application form"],
    important_dates: ["Applications close: March 1"],
  },
};

describe("source intake worker helpers", () => {
  it("normalizes Gemini intake output and builds baseline facts", () => {
    const normalized = normalizeGeminiIntakeResult(acceptedReview);
    expect(normalized.status).toBe("accepted");
    expect(normalized.evidence_quotes).toEqual(["Example Research Fellowship applications close March 1."]);

    const facts = baselineFactsFromIntakeReview(normalized);
    expect(facts.award_relevance).toBe("primary");
    expect(facts.cycle_relevance).toBe("current_or_upcoming");
    expect(facts.deadline).toBe("March 1");
  });

  it("fails closed when Gemini omits exact evidence", () => {
    const decision = validateIntakeAiDecision({ ...acceptedReview, evidence_quotes: [] });
    expect(decision.accepted).toBe(false);
    expect(decision.manual).toBe(true);
    expect(decision.reason).toBe("missing_evidence_quotes");
  });

  it("rejects sibling or generic listing decisions", () => {
    const sibling = validateIntakeAiDecision({
      ...acceptedReview,
      source_relevance: "sibling_program",
      rejection_reason: "sibling award",
    });
    expect(sibling.accepted).toBe(false);
    expect(sibling.manual).toBe(false);
    expect(sibling.reason).toBe("source_relevance_sibling_program");
  });

  it("matches an existing award by award identity and official url", () => {
    const match = matchSourceToExistingAward({
      awards: [
        { id: "a1", name: "Other Award", official_homepage: "https://other.edu/award" },
        { id: "a2", name: "Example Research Fellowship", official_homepage: "https://example.edu/research-fellowship" },
      ],
      request,
      capture,
      review: acceptedReview,
    });
    expect(match?.award.id).toBe("a2");
    expect(match?.score).toBeGreaterThan(0.85);
  });

  it("only creates new awards for high-confidence official primary pages", () => {
    const create = shouldCreateNewAwardFromIntake({
      review: acceptedReview,
      deterministicReview: { allowed: true, reason: "passes" },
      request,
      capture,
    });
    expect(create.create).toBe(true);

    const listing = shouldCreateNewAwardFromIntake({
      review: { ...acceptedReview, source_relevance: "generic_listing" },
      deterministicReview: { allowed: true, reason: "passes" },
      request,
      capture,
    });
    expect(listing.create).toBe(false);
  });

  it("builds monitorable source rows from accepted reviews", () => {
    const source = sourceLikeFromIntake({ request, capture, review: acceptedReview });
    expect(source.url).toBe("https://example.edu/research-fellowship");
    expect(source.page_type).toBe("homepage");
    expect(source.page_metadata.baseline_facts.award_relevance).toBe("primary");
  });
});
