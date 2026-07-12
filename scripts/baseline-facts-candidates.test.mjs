import { describe, expect, it } from "vitest";
import {
  baselineFactsRejectionDisposition,
  baselineReviewPreflightDecision,
} from "./lib/baseline-facts-candidates.mjs";

const cleanSource = {
  id: "source-1",
  url: "https://example.edu/fellowships/research-award",
  title: "Research Award",
  page_type: "homepage",
  page_metadata: {},
};

describe("baseline fact candidate preflight", () => {
  it("allows a clean unreviewed source to receive its first AI review", () => {
    const decision = baselineReviewPreflightDecision({ source: cleanSource });

    expect(decision.shouldReview).toBe(true);
    expect(decision.reason).toBe("eligible_for_ai_review");
  });

  it("does not rereview an existing complete accepted source by default", () => {
    const source = {
      ...cleanSource,
      page_metadata_generated_at: "2026-07-11T00:00:00.000Z",
      page_metadata_model: "gemini-2.5-flash-lite",
      page_metadata: {
        baseline_facts: {
          award_relevance: "primary",
          cycle_relevance: "current_or_upcoming",
          confidence: "high",
          evidence_quotes: ["Research Award applications are open."],
        },
      },
    };

    const decision = baselineReviewPreflightDecision({ source, hasExistingFacts: true });

    expect(decision.shouldReview).toBe(false);
    expect(decision.reason).toBe("existing_complete_ai_review");
  });

  it("allows a forced rereview when prior relevance is unclear", () => {
    const source = {
      ...cleanSource,
      page_metadata: {
        baseline_facts: {
          award_relevance: "unclear",
          cycle_relevance: "unclear",
        },
      },
    };

    const decision = baselineReviewPreflightDecision({
      source,
      hasExistingFacts: true,
      force: true,
    });

    expect(decision.shouldReview).toBe(true);
    expect(decision.reason).toBe("force_recheck_unclear");
  });

  it("reviews unresolved unclear metadata during the normal catch-up run", () => {
    const source = {
      ...cleanSource,
      page_metadata: {
        baseline_facts: {
          award_relevance: "unclear",
          cycle_relevance: "unclear",
        },
      },
    };

    const decision = baselineReviewPreflightDecision({
      source,
      hasExistingFacts: true,
    });

    expect(decision.shouldReview).toBe(true);
    expect(decision.reason).toBe("resolve_unclear_ai_metadata");
  });

  it("does not repeatedly review a durable rejected result", () => {
    const source = {
      ...cleanSource,
      page_metadata: {
        baseline_facts_rejected: true,
        rejection_reason: "cycle_relevance_unclear",
      },
    };

    const decision = baselineReviewPreflightDecision({ source });

    expect(decision.shouldReview).toBe(false);
    expect(decision.reason).toBe("baseline_facts_rejected");
  });

  it("rejects bad URL shapes before any capture data is needed", () => {
    const decision = baselineReviewPreflightDecision({
      source: {
        ...cleanSource,
        url: "https://example.edu/careers/jobs/1234",
      },
      force: true,
    });

    expect(decision.shouldReview).toBe(false);
    expect(decision.reason).toBe("url_not_monitorable");
  });

  it("does not duplicate an active Batch request", () => {
    const decision = baselineReviewPreflightDecision({
      source: cleanSource,
      activeBatchRequest: true,
    });

    expect(decision.shouldReview).toBe(false);
    expect(decision.reason).toBe("active_batch_request");
  });
});

describe("baseline fact rejection disposition", () => {
  it("keeps an award-specific source open when only its cycle is unclear", () => {
    const disposition = baselineFactsRejectionDisposition({
      facts: {
        award_relevance: "primary",
        cycle_relevance: "unclear",
        quality_flags: [],
      },
      reason: "cycle_relevance_unclear",
    });

    expect(disposition.reviewLater).toBe(false);
    expect(disposition.addSourceMismatch).toBe(false);
    expect(disposition.status).toBe("needs_review");
  });

  it("moves sibling-program sources to review later", () => {
    const disposition = baselineFactsRejectionDisposition({
      facts: {
        award_relevance: "supporting",
        cycle_relevance: "current_or_upcoming",
        quality_flags: ["sibling-program"],
      },
      reason: "quality_flag_sibling_program",
    });

    expect(disposition.reviewLater).toBe(true);
    expect(disposition.addSourceMismatch).toBe(true);
  });

  it("moves archived pages to review later without fabricating an identity mismatch", () => {
    const disposition = baselineFactsRejectionDisposition({
      facts: {
        award_relevance: "primary",
        cycle_relevance: "archived_or_past",
        quality_flags: [],
      },
      reason: "cycle_relevance_archived_or_past",
    });

    expect(disposition.reviewLater).toBe(true);
    expect(disposition.addSourceMismatch).toBe(false);
  });
});
