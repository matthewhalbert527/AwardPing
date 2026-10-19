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
import {
  sourceMonitoringRestoreDecisionReason,
  sourceMonitoringRestoreMarker,
  sourceQualityDecision,
} from "@/lib/source-quality";

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

function trumanLegacyRejection() {
  return {
    id: "49d67597-b5a4-490c-a05f-04331b043cc5",
    shared_award_id: "bf04d4c1-4db3-4f4e-bf1b-e4dbca7bb7d3",
    url: "https://www.truman.gov/apply/applying/eligibility",
    title: "Eligibility",
    page_type: "application",
    admin_review_status: "review_later",
    admin_review_note: "AI coverage backfill moved source out of open: unrelated_but_open; unrelated_but_open.",
    admin_reviewed_at: "2026-07-14T03:33:11.218Z",
    admin_reviewed_by: "open-source-ai-coverage-backfill",
    page_metadata_generated_at: "2026-07-12T14:28:12.672Z",
    page_metadata_model: "gemini-2.5-flash-lite",
    page_metadata: {
      kind: "source_page_outline",
      model: "gemini-2.5-flash-lite",
      version: 1,
      provider: "gemini",
      final_url: "https://www.truman.gov/apply/applying/eligibility",
      generated_at: "2026-07-12T14:28:12.672Z",
      quality_flags: [] as string[],
      baseline_facts: null,
      rejection_reason: "cycle_relevance_unclear",
      baseline_facts_rejected: true,
      baseline_facts_metadata: {
        model: "gemini-2.5-flash-lite",
        reason: "baseline_facts_backfill",
        status: "succeeded",
        extracted_at: "2026-06-26T13:08:01.380Z",
      },
      ai_review_coverage_backfill: {
        at: "2026-07-14T03:33:11.218Z",
        action: "move_to_review_later",
        reason: "unrelated_but_open",
      },
    },
  };
}

describe("legacy cycle-unclear rejection classification", () => {
  it("classifies the retained Truman metadata shape without rewriting its verdict or opening monitoring", () => {
    const held = trumanLegacyRejection();
    const before = structuredClone(held);
    expect(explainSourceAiReviewStatus(held)).toMatchObject({
      status: "reviewed_unclear_needs_manual_review",
      reason: "baseline_facts_rejected_cycle-relevance-unclear",
      rejectionReason: "cycle_relevance_unclear",
      complete: true,
      needsManualReview: true,
      needsAiReview: false,
      canBeMonitored: false,
      canContributePublicFacts: false,
      hasBaselineFacts: false,
      hasBaselineFactsRejected: true,
    });
    expect(sourceBaselineFacts(held)).toEqual({});
    for (const purpose of ["monitoring", "facts", "public"] as const) {
      expect(sourceQualityDecision(held, { purpose }).allowed).toBe(false);
    }
    expect(held).toEqual(before);
  });

  it.each(["cycle_relevance_unclear", "cycle-relevance-unclear", " CYCLE RELEVANCE UNCLEAR "])(
    "recognizes only the exact normalized cycle-unclear key: %s",
    (reason) => {
      const held = trumanLegacyRejection();
      held.page_metadata.rejection_reason = reason;
      expect(getSourceAiReviewStatus(held)).toBe("reviewed_unclear_needs_manual_review");
      expect(sourceCanBeMonitored(held)).toBe(false);
      expect(sourceCanContributePublicFacts(held)).toBe(false);
    },
  );

  it.each([
    ["award_relevance_unclear", "reviewed_rejected_unrelated"],
    ["cycle_unclear", "reviewed_rejected_unrelated"],
    ["cycle_relevance_unclear_extra", "reviewed_rejected_unrelated"],
    ["prefix_cycle_relevance_unclear", "reviewed_rejected_unrelated"],
    ["unknown_rejection", "reviewed_rejected_unrelated"],
    ["cycle_relevance_unclear_access_error", "reviewed_rejected_access_error"],
    ["cycle_relevance_unclear_archived_or_past", "reviewed_rejected_archived_or_past"],
    ["cycle_relevance_unclear_sibling_program", "reviewed_rejected_sibling_program"],
    ["cycle_relevance_unclear_generic_listing", "reviewed_rejected_generic_listing"],
  ])("does not weaken nearby, mixed or unknown rejection %s", (reason, expected) => {
    const held = trumanLegacyRejection();
    held.page_metadata.rejection_reason = reason;
    expect(getSourceAiReviewStatus(held)).toBe(expected);
    expect(sourceNeedsManualReview(held)).toBe(false);
    expect(sourceCanBeMonitored(held)).toBe(false);
    expect(sourceCanContributePublicFacts(held)).toBe(false);
  });

  it.each([
    "source-mismatch", "spam", "job-board", "career-page", "search-results",
    "generic-listing", "sibling-program", "access-error", "hacked-page",
    "pharma-spam", "unrelated-program", "payment", "profile", "recipient",
    "news", "not-program-page",
  ])("retains hard-flag precedence for %s", (flag) => {
    const held = trumanLegacyRejection();
    held.page_metadata.quality_flags = [flag];
    const result = explainSourceAiReviewStatus(held);
    expect(result.reason).toBe("quality_flag_" + flag);
    expect(result.status).not.toBe("reviewed_unclear_needs_manual_review");
    expect(result.canBeMonitored).toBe(false);
    expect(result.canContributePublicFacts).toBe(false);
  });

  it("does not let an unclear rejection bypass missing metadata or a failed review", () => {
    const missingModel = {
      ...trumanLegacyRejection(),
      page_metadata_model: null,
      page_metadata: {
        ...trumanLegacyRejection().page_metadata,
        model: null,
        baseline_facts_metadata: { status: "succeeded" },
      },
    };
    expect(getSourceAiReviewStatus(missingModel)).toBe("reviewed_invalid_or_incomplete");
    const failed = trumanLegacyRejection();
    failed.page_metadata.baseline_facts_metadata.status = "failed";
    expect(getSourceAiReviewStatus(failed)).toBe("review_failed");
  });

  it("keeps the existing explicit restoration monitoring-only without changing AI metadata", () => {
    const held = trumanLegacyRejection();
    const restored = {
      ...held,
      admin_review_status: "open",
      admin_review_note: sourceMonitoringRestoreMarker + ": Explicitly restored for monitoring only.",
      admin_reviewed_at: "2026-10-19T21:00:00.000Z",
      admin_reviewed_by: "operator@example.edu",
    };
    expect(sourceQualityDecision(restored, { purpose: "monitoring" })).toMatchObject({
      allowed: true,
      reason: sourceMonitoringRestoreDecisionReason,
    });
    expect(sourceCanBeMonitored(restored)).toBe(false);
    expect(sourceQualityDecision(restored, { purpose: "facts" }).allowed).toBe(false);
    expect(sourceQualityDecision(restored, { purpose: "public" }).allowed).toBe(false);
    expect(restored.page_metadata).toBe(held.page_metadata);
    expect(held.admin_review_status).toBe("review_later");
  });
});
