import { describe, expect, it } from "vitest";
import {
  explainSourceAiReviewStatus,
  getSourceAiReviewStatus,
  sourceCanBeMonitored,
  sourceCanContributePublicFacts,
  sourceBaselineFacts,
  sourceHasClearAiDetermination,
  sourceNeedsAiReview,
  sourceNeedsManualReview,
} from "@/lib/source-ai-review-status";

const primaryCurrentFacts = {
  award_relevance: "primary",
  cycle_relevance: "current_or_upcoming",
  confidence: "high",
  evidence_quotes: ["Applications close February 1, 2027."],
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-1",
    url: "https://example.edu/award/apply",
    title: "Apply",
    page_metadata_generated_at: "2026-07-08T00:00:00.000Z",
    page_metadata_model: "gemini-test",
    page_metadata: {
      kind: "source_page_outline",
      baseline_facts: primaryCurrentFacts,
      baseline_facts_metadata: {
        status: "succeeded",
        model: "gemini-test",
      },
    },
    ...overrides,
  };
}

describe("source AI review status", () => {
  it("marks sources with no page metadata as unreviewed", () => {
    const unreviewed = source({
      page_metadata_generated_at: null,
      page_metadata_model: null,
      page_metadata: null,
    });

    expect(getSourceAiReviewStatus(unreviewed)).toBe("unreviewed");
    expect(sourceNeedsAiReview(unreviewed)).toBe(true);
    expect(sourceCanBeMonitored(unreviewed)).toBe(false);
  });

  it("does not mistake queue bookkeeping for legacy baseline facts", () => {
    const queued = source({
      page_metadata_generated_at: null,
      page_metadata_model: null,
      page_metadata: {
        ai_review_coverage_backfill: {
          action: "queue_ai_review",
          category: "unreviewed",
        },
      },
    });

    const explanation = explainSourceAiReviewStatus(queued);
    expect(explanation.status).toBe("unreviewed");
    expect(explanation.hasBaselineFacts).toBe(false);
    expect(sourceBaselineFacts(queued)).toEqual({});

    const legacy = source({ page_metadata: primaryCurrentFacts });
    expect(sourceBaselineFacts(legacy)).toEqual(primaryCurrentFacts);
  });

  it("accepts primary current facts for public facts and monitoring", () => {
    expect(getSourceAiReviewStatus(source())).toBe("reviewed_accepted_primary");
    expect(sourceHasClearAiDetermination(source())).toBe(true);
    expect(sourceCanContributePublicFacts(source())).toBe(true);
    expect(sourceCanBeMonitored(source())).toBe(true);
  });

  it("accepts supporting evergreen facts", () => {
    const supporting = source({
      page_metadata: {
        kind: "source_page_outline",
        baseline_facts: {
          ...primaryCurrentFacts,
          award_relevance: "supporting",
          cycle_relevance: "evergreen",
        },
      },
    });

    expect(getSourceAiReviewStatus(supporting)).toBe("reviewed_accepted_supporting");
    expect(sourceCanContributePublicFacts(supporting)).toBe(true);
  });

  it("rejects unrelated, sibling, archived, not-program, access, and generic sources", () => {
    expect(
      getSourceAiReviewStatus(
        source({
          page_metadata: {
            baseline_facts: { ...primaryCurrentFacts, award_relevance: "unrelated" },
          },
        }),
      ),
    ).toBe("reviewed_rejected_unrelated");

    expect(
      getSourceAiReviewStatus(
        source({
          page_metadata: {
            baseline_facts: { ...primaryCurrentFacts, quality_flags: ["sibling-program"] },
          },
        }),
      ),
    ).toBe("reviewed_rejected_sibling_program");

    expect(
      getSourceAiReviewStatus(
        source({
          page_metadata: {
            baseline_facts: { ...primaryCurrentFacts, cycle_relevance: "archived_or_past" },
          },
        }),
      ),
    ).toBe("reviewed_rejected_archived_or_past");

    expect(
      getSourceAiReviewStatus(
        source({
          page_metadata: {
            baseline_facts: { ...primaryCurrentFacts, cycle_relevance: "not_program_page" },
          },
        }),
      ),
    ).toBe("reviewed_rejected_not_program_page");

    expect(
      getSourceAiReviewStatus(
        source({
          page_metadata: {
            baseline_facts: { ...primaryCurrentFacts, quality_flags: ["access-error"] },
          },
        }),
      ),
    ).toBe("reviewed_rejected_access_error");

    expect(
      getSourceAiReviewStatus(
        source({
          page_metadata: {
            baseline_facts: { ...primaryCurrentFacts, quality_flags: ["generic-listing"] },
          },
        }),
      ),
    ).toBe("reviewed_rejected_generic_listing");
  });

  it("routes unclear and low-confidence reviews to manual review", () => {
    const unclear = source({
      page_metadata: {
        baseline_facts: {
          ...primaryCurrentFacts,
          award_relevance: "unclear",
        },
      },
    });
    const lowConfidence = source({
      page_metadata: {
        baseline_facts: {
          ...primaryCurrentFacts,
          confidence: "low",
        },
      },
    });

    expect(getSourceAiReviewStatus(unclear)).toBe("reviewed_unclear_needs_manual_review");
    expect(sourceNeedsManualReview(unclear)).toBe(true);
    expect(getSourceAiReviewStatus(lowConfidence)).toBe("reviewed_unclear_needs_manual_review");
  });

  it("requires cycle relevance for accepted sources", () => {
    const missingCycle = source({
      page_metadata: {
        baseline_facts: {
          award_relevance: "primary",
          confidence: "high",
        },
      },
    });

    const explanation = explainSourceAiReviewStatus(missingCycle);
    expect(explanation.status).toBe("reviewed_invalid_or_incomplete");
    expect(explanation.reason).toBe("missing_cycle_relevance");
    expect(explanation.complete).toBe(false);
  });

  it("requires a rejection reason when baseline facts are rejected", () => {
    const rejected = source({
      page_metadata: {
        baseline_facts_rejected: true,
        rejection_reason: "access_error",
      },
    });
    const invalid = source({
      page_metadata: {
        baseline_facts_rejected: true,
      },
    });

    expect(getSourceAiReviewStatus(rejected)).toBe("reviewed_rejected_access_error");
    expect(sourceHasClearAiDetermination(rejected)).toBe(true);
    expect(getSourceAiReviewStatus(invalid)).toBe("reviewed_invalid_or_incomplete");
  });

  it("marks failed Gemini metadata as review_failed", () => {
    const failed = source({
      page_metadata: {
        baseline_facts_metadata: {
          status: "failed",
          error: "Gemini billing blocked",
        },
      },
    });

    expect(getSourceAiReviewStatus(failed)).toBe("review_failed");
    expect(sourceNeedsAiReview(failed)).toBe(true);
  });
});
